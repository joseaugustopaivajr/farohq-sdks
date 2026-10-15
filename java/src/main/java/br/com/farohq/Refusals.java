package br.com.farohq;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Recusa do FaroHQ não pode passar em silêncio: chave errada, conta bloqueada, cota ou endereço errado
 * aparecem uma vez no stderr com o motivo (direto no stderr: o Logback está capturado e o aviso não
 * pode virar log enviado). Com a chave recusada (401), o SDK para de enviar.
 */
final class Refusals {

    private static final Pattern MESSAGE = Pattern.compile("\"message\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");

    private final FaroHQOptions options;
    private final Set<String> warned = ConcurrentHashMap.newKeySet();
    private volatile boolean rejected;

    Refusals(FaroHQOptions options) {
        this.options = options;
    }

    boolean rejected() {
        return rejected;
    }

    void check(HttpResponse<String> res) {
        int status = res.statusCode();
        if (status < 400 || status >= 500) {
            return;
        }
        String why = "";
        Matcher m = MESSAGE.matcher(res.body() == null ? "" : res.body());
        if (m.find()) {
            why = ": " + m.group(1).replace("\\\"", "\"");
        }
        if (status == 401) {
            rejected = true;
            warn("401", "Chave recusada (401)" + why + ". Nada está sendo enviado ao FaroHQ.");
        } else if (status == 403) {
            warn("403", "Envio recusado (403)" + why + ".");
        } else if (status == 404) {
            warn("404", "Endereço do FaroHQ não encontrado (404): confira FAROHQ_ENDPOINT (" + options.endpoint + ").");
        } else if (status == 429) {
            warn("429", "Limite atingido (429)" + why + ". Parte dos dados está sendo descartada.");
        }
    }

    /** Confere a chave ao iniciar, numa thread à parte: sem isso, uma chave errada só apareceria no primeiro erro. */
    void verifyInBackground(HttpClient http) {
        if (!options.endpoint.matches(".*/ingest/event/?$")) {
            return;
        }
        String url = options.endpoint.replaceAll("/ingest/event/?$", "/ingest/ping");
        Thread t = new Thread(() -> {
            try {
                HttpRequest req = HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(5))
                        .header("X-FaroHQ-Key", options.key).header("User-Agent", FaroHQClient.USER_AGENT).GET().build();
                check(http.send(req, HttpResponse.BodyHandlers.ofString()));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } catch (Exception e) {
                warn("net", "Não foi possível falar com o FaroHQ (" + url + "): " + e.getMessage() + ".");
            }
        }, "farohq-verify");
        t.setDaemon(true);
        t.start();
    }

    void warn(String code, String message) {
        if (warned.add(code)) {
            System.err.println("[FaroHQ] " + message);
        }
    }
}
