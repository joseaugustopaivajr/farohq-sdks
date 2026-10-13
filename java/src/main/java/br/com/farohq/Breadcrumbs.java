package br.com.farohq;

import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

/**
 * Os últimos logs de cada thread (o "rastro" antes do erro). Cada requisição roda numa thread,
 * então o rastro é o da requisição. Quando o traceId muda (nova requisição na mesma thread do pool),
 * o rastro recomeça; sem traceId, valem só as linhas dos últimos minutos.
 */
public final class Breadcrumbs {

    /** Uma linha de log guardada. */
    public static final class Crumb {
        final Instant timestamp;
        final String level;
        final String logger;
        final String message;

        Crumb(Instant timestamp, String level, String logger, String message) {
            this.timestamp = timestamp;
            this.level = level;
            this.logger = logger;
            this.message = message;
        }
    }

    private static final class Trail {
        final ArrayDeque<Crumb> crumbs = new ArrayDeque<>();
        String traceId;
    }

    private static final ThreadLocal<Trail> TRAIL = ThreadLocal.withInitial(Trail::new);

    private Breadcrumbs() {
    }

    /** Guarda uma linha no rastro da thread atual. */
    public static void add(String level, String logger, String message, String traceId, int max) {
        if (max <= 0 || message == null) {
            return;
        }
        Trail t = TRAIL.get();
        if (traceId != null && !Objects.equals(traceId, t.traceId)) {
            t.crumbs.clear();
            t.traceId = traceId;
        }
        if (message.length() > 1000) {
            message = message.substring(0, 1000);
        }
        t.crumbs.addLast(new Crumb(Instant.now(), level, logger, message));
        while (t.crumbs.size() > max) {
            t.crumbs.removeFirst();
        }
    }

    /** Rastro da thread atual (só as linhas da mesma requisição, ou dos últimos minutos). */
    static List<Crumb> snapshot(String traceId, long maxAgeSeconds) {
        Trail t = TRAIL.get();
        if (traceId != null && t.traceId != null && !traceId.equals(t.traceId)) {
            return List.of();
        }
        Instant cutoff = Instant.now().minusSeconds(maxAgeSeconds);
        List<Crumb> out = new ArrayList<>(t.crumbs.size());
        for (Crumb c : t.crumbs) {
            if (!c.timestamp.isBefore(cutoff)) {
                out.add(c);
            }
        }
        return out;
    }

    /** Esquece o rastro da thread atual (ex.: no fim de uma requisição). */
    public static void clear() {
        TRAIL.remove();
    }
}
