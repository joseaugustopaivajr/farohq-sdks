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
    public string Endpoint { get; set; } = "http://localhost:8030/api/v1/ingest/event";

    /// <summary>Ambiente (production, staging...). Padrão: ASPNETCORE_ENVIRONMENT.</summary>
    public string? Environment { get; set; }

    /// <summary>Versão do deploy. Use o SHA do commit: é com ele que a IA lê o código certo.</summary>
    public string? Release { get; set; }

    /// <summary>Nome do serviço que aparece no FaroHQ. Padrão: nome do assembly de entrada.</summary>
    public string? Service { get; set; }

    /// <summary>A partir de qual nível um log vira evento no FaroHQ.</summary>
    public LogLevel MinimumLevel { get; set; } = LogLevel.Error;

    /// <summary>Desliga o envio sem tirar o código (ex.: em testes).</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>Máximo de eventos na fila em memória; acima disso, os mais novos são descartados.</summary>
    public int QueueCapacity { get; set; } = 1000;

    internal bool CanSend => Enabled && !string.IsNullOrWhiteSpace(Key) && !string.IsNullOrWhiteSpace(Endpoint);
}
