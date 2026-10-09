package br.com.farohq;

/**
 * Configuração do FaroHQ. Valores não informados vêm das variáveis de ambiente
 * FAROHQ_KEY, FAROHQ_ENDPOINT, FAROHQ_ENV e GIT_SHA.
 */
public final class FaroHQOptions {

    public static final String DEFAULT_ENDPOINT = "https://api.farohq.com.br/api/v1/ingest/event";

    String key = env("FAROHQ_KEY");
    String endpoint = orDefault(env("FAROHQ_ENDPOINT"), DEFAULT_ENDPOINT);
    String environment = orDefault(env("FAROHQ_ENV"), "production");
    String release = env("GIT_SHA");
    String service;
    int queueCapacity = 1000;
    boolean enabled = true;

    /** Chave de ingestão do projeto (farohq_...). Sem ela, nada é enviado. */
    public FaroHQOptions key(String key) {
        this.key = key;
        return this;
    }

    public FaroHQOptions endpoint(String endpoint) {
        this.endpoint = endpoint;
        return this;
    }

    public FaroHQOptions environment(String environment) {
        this.environment = environment;
        return this;
    }

    /** Versão do deploy. Use o SHA do commit: é com ele que a IA lê o código certo. */
    public FaroHQOptions release(String release) {
        this.release = release;
        return this;
    }

    public FaroHQOptions service(String service) {
        this.service = service;
        return this;
    }

    public FaroHQOptions queueCapacity(int queueCapacity) {
        this.queueCapacity = queueCapacity;
        return this;
    }

    public FaroHQOptions enabled(boolean enabled) {
        this.enabled = enabled;
        return this;
    }

    boolean canSend() {
        return enabled && key != null && !key.isBlank() && endpoint != null && !endpoint.isBlank();
    }

    private static String env(String name) {
        String v = System.getenv(name);
        return v == null || v.isBlank() ? null : v;
    }

    private static String orDefault(String v, String def) {
        return v == null ? def : v;
    }
}
