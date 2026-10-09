package br.com.farohq;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
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

    public FaroHQClient(FaroHQOptions options) {
        this.options = options;
        this.queue = new ArrayBlockingQueue<>(Math.max(1, options.queueCapacity));
        this.worker = new Thread(this::loop, "farohq-sender");
        this.worker.setDaemon(true);
        this.worker.start();
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
        enqueue(message, error, context);
    }

    void enqueue(String message, Throwable error, Map<String, String> context) {
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
            queue.offer(toJson(message, error, context, Instant.now()));
        } catch (RuntimeException ignored) {
            // Reportar erro nunca pode derrubar a aplicação
        }
    }

    String toJson(String message, Throwable error, Map<String, String> context, Instant when) {
        StringBuilder sb = new StringBuilder(512).append('{');
        Json.field(sb, "level", "error").append(',');
        Json.field(sb, "environment", options.environment).append(',');
        Json.field(sb, "release", options.release).append(',');
        Json.field(sb, "service", options.service).append(',');
        Json.field(sb, "message", message).append(',');
        Json.field(sb, "timestamp", when.toString());
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
                    send(body);
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
                    .header("User-Agent", "farohq-java/0.1.0")
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .build();
            http.send(request, HttpResponse.BodyHandlers.discarding());
        } catch (Exception ignored) {
            // FaroHQ fora do ar ou rede caiu: o evento se perde, a aplicação segue
        }
    }

    /** Espera a fila esvaziar (até o tempo dado). Chame ao desligar a aplicação. */
    public void flush(Duration timeout) {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (!queue.isEmpty() && System.nanoTime() < deadline) {
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
