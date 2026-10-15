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
    private final List<String> logBodies = new CopyOnWriteArrayList<>();
    private String endpoint;

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/ingest", ex -> {
            if ("GET".equals(ex.getRequestMethod())) { // verificação da chave ao iniciar
                ex.sendResponseHeaders(200, -1);
                ex.close();
                return;
            }
            String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            if (ex.getRequestURI().getPath().endsWith("/logs")) {
                logBodies.add(body);
                ex.sendResponseHeaders(202, -1);
                ex.close();
                return;
            }
            keys.add(ex.getRequestHeaders().getFirst("X-FaroHQ-Key"));
            bodies.add(body);
            ex.sendResponseHeaders(202, -1);
            ex.close();
        });
        server.start();
        endpoint = "http://127.0.0.1:" + server.getAddress().getPort() + "/ingest/event";
    }

    @AfterEach
    void stop() {
        server.stop(0);
    }

    @Test
    void chaveRecusadaAvisaUmaVezEParaDeEnviar() throws Exception {
        List<String> hits = new CopyOnWriteArrayList<>();
        HttpServer refuses = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        refuses.createContext("/", ex -> {
            hits.add(ex.getRequestMethod() + " " + ex.getRequestURI().getPath());
            ex.getRequestBody().readAllBytes();
            byte[] b = "{\"status\":401,\"message\":\"Chave de projeto inválida\"}".getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().add("Content-Type", "application/json");
            ex.sendResponseHeaders(401, b.length);
            ex.getResponseBody().write(b);
            ex.close();
        });
        refuses.start();
        java.io.PrintStream err = System.err;
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        System.setErr(new java.io.PrintStream(out, true, StandardCharsets.UTF_8));
        try {
            FaroHQClient c = new FaroHQClient(new FaroHQOptions().key("farohq_errada")
                    .endpoint("http://127.0.0.1:" + refuses.getAddress().getPort() + "/api/v1/ingest/event"));
            long until = System.currentTimeMillis() + 3000;
            while (!out.toString(StandardCharsets.UTF_8).contains("[FaroHQ]") && System.currentTimeMillis() < until) {
                Thread.sleep(20);
            }
            c.captureMessage("depois da recusa", null);
            c.flush(Duration.ofSeconds(2));
        } finally {
            System.setErr(err);
            refuses.stop(0);
        }
        String text = out.toString(StandardCharsets.UTF_8);
        assertEquals(List.of("GET /api/v1/ingest/ping"), hits);
        assertEquals(1, text.split("\\[FaroHQ\\]", -1).length - 1, text);
        assertTrue(text.contains("Chave recusada (401): Chave de projeto inválida"), text);
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

    @Test
    void appenderMandaAsLinhasAnterioresEOTraceId() {
        LoggerContext ctx = (LoggerContext) LoggerFactory.getILoggerFactory();
        FaroHQAppender appender = new FaroHQAppender();
        appender.setContext(ctx);
        appender.setKey("farohq_logback");
        appender.setEndpoint(endpoint);
        appender.start();
        Logger logger = ctx.getLogger("loja.checkout");
        logger.addAppender(appender);

        org.slf4j.MDC.put("traceId", "req-antiga");
        logger.info("linha de outra requisição");
        org.slf4j.MDC.put("traceId", "req-42");
        logger.debug("debug não entra");
        logger.info("POST /checkout iniciado");
        logger.warn("estoque baixo");
        logger.error("Falha no checkout", new IllegalStateException("sem itens"));
        org.slf4j.MDC.clear();
        FaroHQ.client().flush(Duration.ofSeconds(5));
        sleep(300);

        assertEquals(1, bodies.size());
        String body = bodies.get(0);
        assertTrue(body.contains("\"traceId\":\"req-42\""), body);
        assertTrue(body.contains("\"message\":\"POST /checkout iniciado\""), body);
        assertTrue(body.contains("\"level\":\"WARN\""), body);
        assertFalse(body.contains("outra requisição"), body);
        assertFalse(body.contains("debug não entra"), body);
        logger.detachAppender(appender);
        appender.stop();
    }

    @Test
    void comShipLogsEnviaAsLinhasEmLote() {
        LoggerContext ctx = (LoggerContext) LoggerFactory.getILoggerFactory();
        FaroHQAppender appender = new FaroHQAppender();
        appender.setContext(ctx);
        appender.setKey("farohq_logs");
        appender.setEndpoint(endpoint);
        appender.setService("loja");
        appender.setShipLogs(true);
        appender.start();
        Logger logger = ctx.getLogger("loja.estoque");
        logger.addAppender(appender);

        org.slf4j.MDC.put("traceId", "req-7");
        logger.debug("debug fica de fora");
        logger.info("Estoque atualizado: SKU {}", 123);
        logger.warn("Estoque baixo");
        org.slf4j.MDC.clear();
        FaroHQ.client().flush(Duration.ofSeconds(5));
        sleep(2500);

        String all = String.join("", logBodies);
        assertTrue(all.contains("\"message\":\"Estoque atualizado: SKU 123\""), all);
        assertTrue(all.contains("\"level\":\"WARN\""), all);
        assertTrue(all.contains("\"traceId\":\"req-7\""), all);
        assertTrue(all.contains("\"service\":\"loja\""), all);
        assertFalse(all.contains("debug fica de fora"), all);
        assertTrue(bodies.isEmpty(), "linhas sem erro não viram evento de erro");
        logger.detachAppender(appender);
        appender.stop();
    }

    @Test
    void flushEsperaOEnvioEmAndamento() throws IOException {
        // Servidor lento: o evento sai da fila, mas a resposta demora. O flush tem que esperar.
        HttpServer slow = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        List<String> got = new CopyOnWriteArrayList<>();
        slow.createContext("/ingest", ex -> {
            sleep(800);
            if ("GET".equals(ex.getRequestMethod())) { // verificação da chave ao iniciar
                ex.sendResponseHeaders(200, -1);
                ex.close();
                return;
            }
            got.add(new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            ex.sendResponseHeaders(202, -1);
            ex.close();
        });
        slow.start();
        try {
            FaroHQClient c = new FaroHQClient(new FaroHQOptions().key("k")
                    .endpoint("http://127.0.0.1:" + slow.getAddress().getPort() + "/ingest/event"));
            c.captureException(new IllegalStateException("último erro antes de sair"));
            c.flush(Duration.ofSeconds(5));
            assertEquals(1, got.size(), "flush voltou antes de o envio terminar");
            c.close();
        } finally {
            slow.stop(0);
        }
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
