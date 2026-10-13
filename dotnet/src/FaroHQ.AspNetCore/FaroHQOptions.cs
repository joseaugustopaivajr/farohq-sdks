using Microsoft.Extensions.Logging;

namespace FaroHQ.AspNetCore;

/// <summary>
/// Configuração do FaroHQ. Lida da seção "FaroHQ" do appsettings e das variáveis
/// FAROHQ_KEY, FAROHQ_ENDPOINT, FAROHQ_ENV e GIT_SHA (as variáveis têm prioridade).
/// </summary>
public sealed class FaroHQOptions
{
    /// <summary>Chave de ingestão do projeto (farohq_...). Sem ela, nada é enviado.</summary>
    public string? Key { get; set; }

    /// <summary>URL completa do endpoint de ingestão.</summary>
    public string Endpoint { get; set; } = "https://api.farohq.com.br/api/v1/ingest/event";

    /// <summary>Ambiente (production, staging...). Padrão: ASPNETCORE_ENVIRONMENT.</summary>
    public string? Environment { get; set; }

    /// <summary>Versão do deploy. Use o SHA do commit: é com ele que o FaroHQ lê o código certo.</summary>
    public string? Release { get; set; }

    /// <summary>Nome do serviço que aparece no FaroHQ. Padrão: nome do assembly de entrada.</summary>
    public string? Service { get; set; }

    /// <summary>A partir de qual nível um log vira evento no FaroHQ.</summary>
    public LogLevel MinimumLevel { get; set; } = LogLevel.Error;

    /// <summary>Logs a partir deste nível (e abaixo de MinimumLevel) ficam no rastro que vai junto com o erro.</summary>
    public LogLevel BreadcrumbLevel { get; set; } = LogLevel.Information;

    /// <summary>Quantas linhas anteriores ao erro vão junto (0 desliga).</summary>
    public int MaxBreadcrumbs { get; set; } = 30;

    /// <summary>
    /// Envia também todos os logs (a partir de LogsLevel) para o módulo de Logs do FaroHQ:
    /// busca, filtros, ao vivo e a requisição inteira ao lado do erro. Padrão: FAROHQ_LOGS=true.
    /// </summary>
    public bool ShipLogs { get; set; }

    /// <summary>Nível mínimo das linhas enviadas ao módulo de Logs.</summary>
    public LogLevel LogsLevel { get; set; } = LogLevel.Information;

    /// <summary>Desliga o envio sem tirar o código (ex.: em testes).</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>Máximo de eventos na fila em memória; acima disso, os mais novos são descartados.</summary>
    public int QueueCapacity { get; set; } = 1000;

    internal bool CanSend => Enabled && !string.IsNullOrWhiteSpace(Key) && !string.IsNullOrWhiteSpace(Endpoint);
}
