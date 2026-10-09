package br.com.farohq;

import java.time.Duration;
import java.util.Map;

/**
 * Atalho estático para quem não usa Logback/Spring:
 * <pre>
 * FaroHQ.init(new FaroHQOptions().service("minha-api"));
 * FaroHQ.installUncaughtExceptionHandler();
 * try { ... } catch (Exception e) { FaroHQ.captureException(e); }
 * </pre>
 */
public final class FaroHQ {

    private static volatile FaroHQClient client;

    private FaroHQ() {
    }

    public static synchronized FaroHQClient init(FaroHQOptions options) {
        if (client != null) {
            client.close();
        }
        client = new FaroHQClient(options);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            FaroHQClient c = client;
            if (c != null) {
                c.flush(Duration.ofSeconds(3));
            }
        }, "farohq-shutdown"));
        return client;
    }

    public static FaroHQClient client() {
        FaroHQClient c = client;
        if (c == null) {
            synchronized (FaroHQ.class) {
                if (client == null) {
                    client = new FaroHQClient(new FaroHQOptions());
                }
                c = client;
            }
        }
        return c;
    }

    public static void captureException(Throwable error) {
        client().captureException(error);
    }

    public static void captureException(Throwable error, Map<String, String> context) {
        client().captureException(error, context);
    }

    public static void captureMessage(String message) {
        client().captureMessage(message, null);
    }

    /** Captura exceções que derrubariam threads (o comportamento padrão continua). */
    public static void installUncaughtExceptionHandler() {
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            captureException(error, Map.of("thread", thread.getName()));
            client().flush(Duration.ofSeconds(3));
            if (previous != null) {
                previous.uncaughtException(thread, error);
            } else {
                error.printStackTrace();
            }
        });
    }
}
