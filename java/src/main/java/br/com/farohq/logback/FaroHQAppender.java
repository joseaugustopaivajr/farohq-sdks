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
        if (!event.getLevel().isGreaterOrEqual(Level.ERROR)) {
            return;
        }
        // Logs do próprio JDK HttpClient não podem gerar novos eventos (laço)
        if (event.getLoggerName().startsWith("jdk.internal.httpclient")) {
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
        client.capture(event.getFormattedMessage(), error, context);
    }
}
