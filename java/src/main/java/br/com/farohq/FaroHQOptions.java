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
    int maxBreadcrumbs = 30;
    long breadcrumbMaxAgeSeconds = 300;
    boolean shipLogs = "true".equalsIgnoreCase(env("FAROHQ_LOGS"));
    int logsQueueCapacity = 10_000;
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

    /** Versão do deploy. Use o SHA do commit: é com ele que o FaroHQ lê o código certo. */
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

    /** Quantas linhas de log anteriores ao erro vão junto (0 desliga). Padrão: 30. */
    public FaroHQOptions maxBreadcrumbs(int maxBreadcrumbs) {
        this.maxBreadcrumbs = Math.max(0, Math.min(maxBreadcrumbs, 100));
        return this;
    }

    /** Sem traceId, só entram linhas desta idade para trás. Padrão: 300s. */
    public FaroHQOptions breadcrumbMaxAgeSeconds(long seconds) {
        this.breadcrumbMaxAgeSeconds = seconds;
        return this;
    }

    /**
     * Envia também todos os logs (não só os erros) para o módulo de Logs do FaroHQ: busca, filtros,
     * ao vivo e a requisição inteira ao lado do erro. Padrão: FAROHQ_LOGS=true ou desligado.
     */
    public FaroHQOptions shipLogs(boolean shipLogs) {
        this.shipLogs = shipLogs;
        return this;
    }

    public boolean shipLogs() {
        return shipLogs;
    }

    public int maxBreadcrumbs() {
        return maxBreadcrumbs;
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
