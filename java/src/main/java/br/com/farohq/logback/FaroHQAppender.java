package br.com.farohq.logback;

import br.com.farohq.FaroHQ;
import br.com.farohq.FaroHQClient;
import br.com.farohq.FaroHQOptions;
import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import ch.qos.logback.classic.spi.ThrowableProxy;
import ch.qos.logback.core.AppenderBase;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Appender do Logback (Spring Boot usa Logback por padrão): tudo que for logado com nível
 * ERROR vira evento no FaroHQ. Configuração no logback-spring.xml:
 * <pre>
 * &lt;appender name="FAROHQ" class="br.com.farohq.logback.FaroHQAppender"&gt;
 *   &lt;service&gt;minha-api&lt;/service&gt;
 * &lt;/appender&gt;
 * </pre>
 * Chave e versão vêm de FAROHQ_KEY e GIT_SHA (ou das tags key/release).
 */
public class FaroHQAppender extends AppenderBase<ILoggingEvent> {

    private final FaroHQOptions options = new FaroHQOptions();
    private FaroHQClient client;
    private Level breadcrumbLevel = Level.INFO;
    private Level logsLevel = Level.INFO;
    private String[] traceIdKeys = {"traceId", "trace_id", "X-B3-TraceId", "dd.trace_id", "requestId", "correlationId"};

    public void setKey(String key) {
        if (key != null && !key.isBlank()) {
            options.key(key);
        }
    }

    public void setEndpoint(String endpoint) {
        if (endpoint != null && !endpoint.isBlank()) {
            options.endpoint(endpoint);
        }
    }

    public void setEnvironment(String environment) {
        if (environment != null && !environment.isBlank()) {
            options.environment(environment);
        }
    }

    public void setRelease(String release) {
        if (release != null && !release.isBlank()) {
            options.release(release);
        }
    }

    public void setService(String service) {
        options.service(service);
    }

    /** Envia todos os logs (a partir de logsLevel) para o módulo de Logs. Padrão: FAROHQ_LOGS. */
    public void setShipLogs(boolean ship) {
        options.shipLogs(ship);
    }

    /** Nível mínimo das linhas enviadas ao módulo de Logs: DEBUG, INFO (padrão), WARN... */
    public void setLogsLevel(String level) {
        logsLevel = Level.toLevel(level, Level.INFO);
    }

    /** Quantas linhas anteriores ao erro vão junto (0 desliga). Padrão: 30. */
    public void setMaxBreadcrumbs(int max) {
        options.maxBreadcrumbs(max);
    }

    /** Nível mínimo das linhas guardadas no rastro: TRACE, DEBUG, INFO (padrão) ou WARN. */
    public void setBreadcrumbLevel(String level) {
        breadcrumbLevel = Level.toLevel(level, Level.INFO);
    }

    /** Chaves do MDC onde procurar o ID da requisição (traceId), separadas por vírgula. */
    public void setTraceIdKeys(String keys) {
        traceIdKeys = keys.split("\\s*,\\s*");
    }

    @Override
    public void start() {
        client = FaroHQ.init(options);
        super.start();
    }

    @Override
    public void stop() {
        if (client != null) {
            client.close();
        }
        super.stop();
    }

    @Override
    protected void append(ILoggingEvent event) {
        // Logs do próprio JDK HttpClient não podem gerar novos eventos (laço)
        if (event.getLoggerName().startsWith("jdk.internal.httpclient")) {
            return;
        }
        String traceId = traceId(event.getMDCPropertyMap());
        if (client.shipsLogs() && event.getLevel().isGreaterOrEqual(logsLevel)) {
            String msg = event.getFormattedMessage();
            IThrowableProxy tp = event.getThrowableProxy();
            if (tp != null) {
                msg = msg + "\n" + tp.getClassName() + ": " + tp.getMessage();
            }
            client.log(event.getLevel().toString(), event.getLoggerName(), msg, traceId, event.getMDCPropertyMap());
        }
        if (!event.getLevel().isGreaterOrEqual(Level.ERROR)) {
            if (event.getLevel().isGreaterOrEqual(breadcrumbLevel)) {
                client.addBreadcrumb(event.getLevel().toString(), event.getLoggerName(),
                        event.getFormattedMessage(), traceId);
            }
            return;
        }
        Throwable error = null;
        IThrowableProxy proxy = event.getThrowableProxy();
        if (proxy instanceof ThrowableProxy) {
            error = ((ThrowableProxy) proxy).getThrowable();
        }
        Map<String, String> context = new LinkedHashMap<>();
        context.put("logger", event.getLoggerName());
        context.put("thread", event.getThreadName());
        if (event.getMDCPropertyMap() != null) {
            event.getMDCPropertyMap().forEach((k, v) -> context.put("mdc." + k, v));
        }
        // Um evento só: a linha do log como mensagem + a exceção (se houver)
        client.capture(event.getFormattedMessage(), error, context, traceId);
    }

    private String traceId(Map<String, String> mdc) {
        if (mdc == null || mdc.isEmpty()) {
            return null;
        }
        for (String k : traceIdKeys) {
            String v = mdc.get(k);
            if (v != null && !v.isBlank()) {
                return v;
            }
        }
        return null;
    }
}
