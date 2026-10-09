package br.com.farohq;

import br.com.farohq.logback.FaroHQAppender;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.LoggerContext;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.junit.jupiter.api.Assertions.*;

class FaroHQClientTest {

    private HttpServer server;
    private final List<String> bodies = new CopyOnWriteArrayList<>();
    private final List<String> keys = new CopyOnWriteArrayList<>();
    private String endpoint;

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/ingest", ex -> {
            keys.add(ex.getRequestHeaders().getFirst("X-FaroHQ-Key"));
            bodies.add(new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            ex.sendResponseHeaders(202, -1);
            ex.close();
        });
        server.start();
        endpoint = "http://127.0.0.1:" + server.getAddress().getPort() + "/ingest";
    }

    @AfterEach
    void stop() {
        server.stop(0);
    }

    @Test
    void jsonEscapaAspasEQuebrasDeLinha() {
        FaroHQClient c = new FaroHQClient(new FaroHQOptions().key("k").endpoint(endpoint).release("abc"));
        String json = c.toJson("linha \"1\"\nlinha 2", null, Map.of("path", "/a\\b"), Instant.parse("2026-01-01T00:00:00Z"));
        assertTrue(json.contains("\"message\":\"linha \\\"1\\\"\\nlinha 2\""), json);
        assertTrue(json.contains("\"path\":\"/a\\\\b\""), json);
        assertTrue(json.contains("\"release\":\"abc\""));
        c.close();
    }

    @Test
    void enviaExcecaoComChaveEStackTrace() {
        FaroHQClient c = new FaroHQClient(new FaroHQOptions().key("farohq_teste").endpoint(endpoint).service("svc"));
        IllegalStateException e = new IllegalStateException("pedido sem itens");
        c.captureException(e, Map.of("path", "/pedidos/42"));
        c.captureException(e); // a mesma exceção não é enviada duas vezes
        c.flush(Duration.ofSeconds(5));
        sleep(300);
        assertEquals(1, bodies.size());
        assertEquals("farohq_teste", keys.get(0));
        String body = bodies.get(0);
        assertTrue(body.contains("\"type\":\"java.lang.IllegalStateException\""), body);
        assertTrue(body.contains("FaroHQClientTest.enviaExcecaoComChaveEStackTrace"), body);
        assertTrue(body.contains("\"service\":\"svc\""));
        c.close();
    }

    @Test
    void semChaveNaoEnviaNada() {
        FaroHQClient c = new FaroHQClient(new FaroHQOptions().key(null).endpoint(endpoint));
        c.captureException(new RuntimeException("x"));
        c.flush(Duration.ofSeconds(1));
        sleep(200);
        assertTrue(bodies.isEmpty());
        c.close();
    }

    @Test
    void appenderDoLogbackEnviaSoErros() {
        LoggerContext ctx = (LoggerContext) LoggerFactory.getILoggerFactory();
        FaroHQAppender appender = new FaroHQAppender();
        appender.setContext(ctx);
        appender.setKey("farohq_logback");
        appender.setEndpoint(endpoint);
        appender.setService("loja");
        appender.start();
        Logger logger = ctx.getLogger("loja.pedidos");
        logger.addAppender(appender);

        logger.info("isso não vai");
        logger.error("Falha ao fechar pedido 42", new NullPointerException("carrinho nulo"));
        FaroHQ.client().flush(Duration.ofSeconds(5));
        sleep(300);

        assertEquals(1, bodies.size());
        String body = bodies.get(0);
        assertTrue(body.contains("\"message\":\"Falha ao fechar pedido 42\""), body);
        assertTrue(body.contains("java.lang.NullPointerException"), body);
        assertTrue(body.contains("\"logger\":\"loja.pedidos\""), body);
        logger.detachAppender(appender);
        appender.stop();
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
