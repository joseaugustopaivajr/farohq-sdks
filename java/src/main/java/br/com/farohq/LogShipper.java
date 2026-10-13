package br.com.farohq;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * Envio de logs para o módulo de Logs do FaroHQ: junta as linhas e manda em lote a cada 2s
 * (ou 500 linhas) numa thread de fundo. Fila cheia descarta a linha: log nunca segura a aplicação.
 */
final class LogShipper {

    private static final int BATCH = 500;

    private final FaroHQOptions options;
    private final String endpoint;
    private final BlockingQueue<String> queue;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private volatile boolean running = true;

    LogShipper(FaroHQOptions options) {
        this.options = options;
        this.endpoint = options.endpoint.replaceAll("/ingest/event/?$", "/ingest/logs");
        this.queue = new ArrayBlockingQueue<>(Math.max(100, options.logsQueueCapacity));
        Thread t = new Thread(this::loop, "farohq-logs");
        t.setDaemon(true);
        t.start();
    }

    void offer(String level, String logger, String message, String traceId, Map<String, String> attributes) {
        if (message == null) {
            return;
        }
        StringBuilder sb = new StringBuilder(256).append('{');
        Json.field(sb, "timestamp", Instant.now().toString()).append(',');
        Json.field(sb, "level", level).append(',');
        Json.field(sb, "logger", logger).append(',');
        Json.field(sb, "message", message.length() > 32_000 ? message.substring(0, 32_000) : message).append(',');
        Json.field(sb, "service", options.service).append(',');
        Json.field(sb, "environment", options.environment).append(',');
        Json.field(sb, "release", options.release).append(',');
        Json.field(sb, "traceId", traceId);
        if (attributes != null && !attributes.isEmpty()) {
            sb.append(",\"attributes\":{");
            boolean first = true;
            for (Map.Entry<String, String> e : attributes.entrySet()) {
                if (!first) {
                    sb.append(',');
                }
                Json.field(sb, e.getKey(), e.getValue());
                first = false;
            }
            sb.append('}');
        }
        queue.offer(sb.append('}').toString());
    }

    private void loop() {
        List<String> batch = new ArrayList<>(BATCH);
        while (running || !queue.isEmpty()) {
            try {
                String first = queue.poll(2, TimeUnit.SECONDS);
                if (first == null) {
                    continue;
                }
                batch.add(first);
                // Espera um pouco para juntar o lote, sem passar de 2s
                long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
                while (batch.size() < BATCH && System.nanoTime() < until) {
                    String next = queue.poll(until - System.nanoTime(), TimeUnit.NANOSECONDS);
                    if (next == null) {
                        break;
                    }
                    batch.add(next);
                }
                send(batch);
                batch.clear();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    private void send(List<String> lines) {
        try {
            String body = "[" + String.join(",", lines) + "]";
            HttpRequest request = HttpRequest.newBuilder(URI.create(endpoint))
                    .timeout(Duration.ofSeconds(10))
                    .header("Content-Type", "application/json")
                    .header("X-FaroHQ-Key", options.key)
                    .header("User-Agent", "farohq-java/0.2.0")
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .build();
            http.send(request, HttpResponse.BodyHandlers.discarding());
        } catch (Exception ignored) {
            // FaroHQ fora do ar: as linhas se perdem, a aplicação segue
        }
    }

    void flush(Duration timeout) {
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

    void close() {
        flush(Duration.ofSeconds(5));
        running = false;
    }
}
