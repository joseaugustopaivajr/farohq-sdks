using System.Net.Http.Json;
using System.Threading.Channels;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;

namespace FaroHQ.AspNetCore;

/// <summary>Envia a fila para o FaroHQ em segundo plano. Falha de rede: o evento é descartado (sem retry infinito).</summary>
internal sealed class FaroHQSender : BackgroundService
{
    internal const string HttpClientName = "farohq";

    private readonly Channel<FaroHQEvent> _queue;
    private readonly IHttpClientFactory _httpFactory;
    private readonly FaroHQOptions _options;

    public FaroHQSender(Channel<FaroHQEvent> queue, IHttpClientFactory httpFactory, IOptions<FaroHQOptions> options)
    {
        _queue = queue;
        _httpFactory = httpFactory;
        _options = options.Value;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var evt in _queue.Reader.ReadAllAsync(stoppingToken))
        {
            await SendAsync(evt, stoppingToken);
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        // Desligando: manda o que ainda está na fila (com o prazo do host)
        _queue.Writer.TryComplete();
        while (_queue.Reader.TryRead(out var evt))
        {
            await SendAsync(evt, cancellationToken);
        }
        await base.StopAsync(cancellationToken);
    }

    private async Task SendAsync(FaroHQEvent evt, CancellationToken ct)
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, _options.Endpoint)
            {
                Content = JsonContent.Create(evt),
            };
            request.Headers.Add("X-FaroHQ-Key", _options.Key);
            using var response = await _httpFactory.CreateClient(HttpClientName).SendAsync(request, ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
        }
        catch
        {
            // FaroHQ fora do ar ou rede caiu: o evento se perde, a aplicação segue
        }
    }
}
