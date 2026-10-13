using System.Net.Http.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;

namespace FaroHQ.AspNetCore;

/// <summary>Uma linha para o módulo de Logs do FaroHQ.</summary>
internal sealed record FaroHQLogLine(
    [property: JsonPropertyName("timestamp")] DateTimeOffset Timestamp,
    [property: JsonPropertyName("level")] string Level,
    [property: JsonPropertyName("logger")] string? Logger,
    [property: JsonPropertyName("message")] string Message,
    [property: JsonPropertyName("service")] string? Service,
    [property: JsonPropertyName("environment")] string? Environment,
    [property: JsonPropertyName("release")] string? Release,
    [property: JsonPropertyName("traceId")] string? TraceId);

/// <summary>Fila das linhas de log (só existe com ShipLogs ligado).</summary>
internal sealed class FaroHQLogQueue
{
    public Channel<FaroHQLogLine> Channel { get; } = System.Threading.Channels.Channel.CreateBounded<FaroHQLogLine>(
        new BoundedChannelOptions(10_000) { FullMode = BoundedChannelFullMode.DropWrite, SingleReader = true });
}

/// <summary>Envia as linhas em lote (500 ou a cada 2s). Falha de rede: o lote se perde, a aplicação segue.</summary>
internal sealed class FaroHQLogShipper : BackgroundService
{
    private const int Batch = 500;

    private readonly FaroHQLogQueue _queue;
    private readonly IHttpClientFactory _httpFactory;
    private readonly FaroHQOptions _options;

    public FaroHQLogShipper(FaroHQLogQueue queue, IHttpClientFactory httpFactory, IOptions<FaroHQOptions> options)
    {
        _queue = queue;
        _httpFactory = httpFactory;
        _options = options.Value;
    }

    private string Url => _options.Endpoint.TrimEnd('/').EndsWith("/ingest/event", StringComparison.Ordinal)
        ? _options.Endpoint.TrimEnd('/')[..^"/ingest/event".Length] + "/ingest/logs"
        : _options.Endpoint;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var reader = _queue.Channel.Reader;
        var batch = new List<FaroHQLogLine>(Batch);
        while (await reader.WaitToReadAsync(stoppingToken))
        {
            var deadline = DateTime.UtcNow.AddSeconds(2);
            while (batch.Count < Batch && DateTime.UtcNow < deadline)
            {
                if (reader.TryRead(out var line))
                {
                    batch.Add(line);
                }
                else
                {
                    await Task.Delay(100, stoppingToken);
                }
            }
            // Sem o token de parada: um lote já começado termina (o HttpClient tem timeout de 10 s)
            await SendAsync(batch, CancellationToken.None);
            batch.Clear();
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        var rest = new List<FaroHQLogLine>();
        while (_queue.Channel.Reader.TryRead(out var line))
        {
            rest.Add(line);
        }
        if (rest.Count > 0)
        {
            await SendAsync(rest, cancellationToken);
        }
        await base.StopAsync(cancellationToken);
    }

    private async Task SendAsync(List<FaroHQLogLine> lines, CancellationToken ct)
    {
        if (lines.Count == 0)
        {
            return;
        }
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, Url) { Content = JsonContent.Create(lines) };
            request.Headers.Add("X-FaroHQ-Key", _options.Key);
            using var response = await _httpFactory.CreateClient(FaroHQSender.HttpClientName).SendAsync(request, ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
        }
        catch
        {
            // FaroHQ fora do ar: as linhas se perdem, a aplicação segue
        }
    }
}
