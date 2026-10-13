package br.com.farohq;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * Cliente do FaroHQ: enfileira eventos em memória e envia numa thread de fundo.
 * Capturar nunca bloqueia nem lança exceção; com a fila cheia, o evento é descartado.
 */
public final class FaroHQClient implements AutoCloseable {

    /** Marca a exceção já enviada, para não mandar duas vezes (ex.: handler + log). */
    static final String CAPTURED = "farohq.captured";

    private final FaroHQOptions options;
    private final BlockingQueue<String> queue;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private final Thread worker;
    private volatile boolean running = true;
    /** Eventos aceitos e ainda não enviados (na fila ou sendo enviados agora). */
    private final java.util.concurrent.atomic.AtomicInteger pending = new java.util.concurrent.atomic.AtomicInteger();
    private final LogShipper logs;

    public FaroHQClient(FaroHQOptions options) {
        this.options = options;
        this.queue = new ArrayBlockingQueue<>(Math.max(1, options.queueCapacity));
        this.worker = new Thread(this::loop, "farohq-sender");
        this.worker.setDaemon(true);
        this.worker.start();
        this.logs = options.shipLogs && options.canSend() ? new LogShipper(options) : null;
    }

    /** Uma linha de log para o módulo de Logs (só se shipLogs estiver ligado). */
    public void log(String level, String logger, String message, String traceId, Map<String, String> attributes) {
        if (logs != null) {
            try {
                logs.offer(level, logger, message, traceId, attributes);
            } catch (RuntimeException ignored) {
                // nunca atrapalha o log da aplicação
            }
        }
    }

    public boolean shipsLogs() {
        return logs != null;
    }

    public void captureException(Throwable error) {
        captureException(error, null);
    }

    public void captureException(Throwable error, Map<String, String> context) {
        if (error == null) {
            return;
        }
        enqueue(error.getMessage(), error, context);
    }

    public void captureMessage(String message, Map<String, String> context) {
        enqueue(message, null, context);
    }

    /** Mensagem (ex.: a linha do log) + exceção opcional + contexto. */
    public void capture(String message, Throwable error, Map<String, String> context) {
        enqueue(message, error, context, null);
    }

    /** Igual, com o ID da requisição (traceId) para ligar o erro aos logs na sua ferramenta. */
    public void capture(String message, Throwable error, Map<String, String> context, String traceId) {
        enqueue(message, error, context, traceId);
    }

    /** Guarda uma linha no rastro da thread atual; vai junto com o próximo erro desta thread. */
    public void addBreadcrumb(String level, String logger, String message, String traceId) {
        Breadcrumbs.add(level, logger, message, traceId, options.maxBreadcrumbs);
    }

    public FaroHQOptions options() {
        return options;
    }

    void enqueue(String message, Throwable error, Map<String, String> context) {
        enqueue(message, error, context, null);
    }

    void enqueue(String message, Throwable error, Map<String, String> context, String traceId) {
        if (!options.canSend()) {
            return;
        }
        try {
            if (error != null && Captured.isMarked(error)) {
                return;
            }
            if (error != null) {
                Captured.mark(error);
            }
            List<Breadcrumbs.Crumb> crumbs = options.maxBreadcrumbs > 0
                    ? Breadcrumbs.snapshot(traceId, options.breadcrumbMaxAgeSeconds) : List.of();
            if (queue.offer(toJson(message, error, context, Instant.now(), traceId, crumbs))) {
                pending.incrementAndGet();
            }
        } catch (RuntimeException ignored) {
            // Reportar erro nunca pode derrubar a aplicação
        }
    }

    String toJson(String message, Throwable error, Map<String, String> context, Instant when) {
        return toJson(message, error, context, when, null, List.of());
    }

    String toJson(String message, Throwable error, Map<String, String> context, Instant when,
                  String traceId, List<Breadcrumbs.Crumb> crumbs) {
        StringBuilder sb = new StringBuilder(512).append('{');
        Json.field(sb, "level", "error").append(',');
        Json.field(sb, "environment", options.environment).append(',');
        Json.field(sb, "release", options.release).append(',');
        Json.field(sb, "service", options.service).append(',');
        Json.field(sb, "message", message).append(',');
        Json.field(sb, "timestamp", when.toString());
        if (traceId != null) {
            sb.append(',');
            Json.field(sb, "traceId", traceId);
        }
        if (crumbs != null && !crumbs.isEmpty()) {
            sb.append(",\"breadcrumbs\":[");
            for (int i = 0; i < crumbs.size(); i++) {
                Breadcrumbs.Crumb c = crumbs.get(i);
                sb.append(i == 0 ? "{" : ",{");
                Json.field(sb, "timestamp", c.timestamp.toString()).append(',');
                Json.field(sb, "level", c.level).append(',');
                Json.field(sb, "logger", c.logger).append(',');
                Json.field(sb, "message", c.message);
                sb.append('}');
            }
            sb.append(']');
        }
        if (error != null) {
            StringWriter sw = new StringWriter();
            error.printStackTrace(new PrintWriter(sw));
            sb.append(",\"exception\":{");
            Json.field(sb, "type", error.getClass().getName()).append(',');
            Json.field(sb, "message", error.getMessage()).append(',');
            Json.field(sb, "stacktrace", sw.toString());
            sb.append('}');
        }
        if (context != null && !context.isEmpty()) {
            sb.append(",\"context\":{");
            boolean first = true;
            for (Map.Entry<String, String> e : context.entrySet()) {
                if (!first) {
                    sb.append(',');
                }
                Json.field(sb, e.getKey(), e.getValue());
                first = false;
            }
            sb.append('}');
        }
        return sb.append('}').toString();
    }

    private void loop() {
        while (running || !queue.isEmpty()) {
            try {
                String body = queue.poll(500, TimeUnit.MILLISECONDS);
                if (body != null) {
                    try {
                        send(body);
                    } finally {
                        pending.decrementAndGet();
                    }
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    private void send(String body) {
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(options.endpoint))
                    .timeout(Duration.ofSeconds(10))
                    .header("Content-Type", "application/json")
                    .header("X-FaroHQ-Key", options.key)
                    .header("User-Agent", "farohq-java/0.2.1")
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .build();
            http.send(request, HttpResponse.BodyHandlers.discarding());
        } catch (Exception ignored) {
            // FaroHQ fora do ar ou rede caiu: o evento se perde, a aplicação segue
        }
    }

    /** Espera a fila esvaziar (até o tempo dado). Chame ao desligar a aplicação. */
    public void flush(Duration timeout) {
        if (logs != null) {
            logs.flush(timeout);
        }
        long deadline = System.nanoTime() + timeout.toNanos();
        // Espera a fila E os envios em andamento: senão o programa termina com o evento a caminho
        while (pending.get() > 0 && System.nanoTime() < deadline) {
            try {
                Thread.sleep(50);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    @Override
    public void close() {
        flush(Duration.ofSeconds(5));
        if (logs != null) {
            logs.close();
        }
        running = false;
    }

    /** Marcação por identidade (Throwable não tem "bag" de dados como no .NET). */
    static final class Captured {
        private static final java.util.Set<Throwable> SEEN =
                java.util.Collections.newSetFromMap(new java.util.WeakHashMap<>());

        static synchronized boolean isMarked(Throwable t) {
            return SEEN.contains(t);
        }

        static synchronized void mark(Throwable t) {
            SEEN.add(t);
        }
    }
}
