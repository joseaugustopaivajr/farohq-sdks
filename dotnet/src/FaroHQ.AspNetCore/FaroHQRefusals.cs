using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace FaroHQ.AspNetCore;

/// <summary>
/// Recusa do FaroHQ não pode passar em silêncio: chave errada, conta bloqueada, cota ou endereço errado
/// aparecem uma vez no stderr com o motivo (direto no stderr: o ILogger está capturado e o aviso não pode
/// virar log enviado). Com a chave recusada (401), o SDK para de enviar.
/// </summary>
internal sealed class FaroHQRefusals
{
    private readonly FaroHQOptions _options;
    private readonly HashSet<string> _warned = new();
    private volatile bool _rejected;

    public FaroHQRefusals(IOptions<FaroHQOptions> options) => _options = options.Value;

    public bool Rejected => _rejected;

    public async Task CheckAsync(HttpResponseMessage response)
    {
        var status = (int)response.StatusCode;
        if (status < 400 || status >= 500)
        {
            return;
        }
        var why = "";
        try
        {
            using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            if (doc.RootElement.TryGetProperty("message", out var m) && m.GetString() is { Length: > 0 } msg)
            {
                why = ": " + msg;
            }
        }
        catch
        {
            // corpo sem JSON
        }
        switch (response.StatusCode)
        {
            case HttpStatusCode.Unauthorized:
                _rejected = true;
                Warn("401", $"Chave recusada (401){why}. Nada está sendo enviado ao FaroHQ.");
                break;
            case HttpStatusCode.Forbidden:
                Warn("403", $"Envio recusado (403){why}.");
                break;
            case HttpStatusCode.NotFound:
                Warn("404", $"Endereço do FaroHQ não encontrado (404): confira FAROHQ_ENDPOINT ({_options.Endpoint}).");
                break;
            case HttpStatusCode.TooManyRequests:
                Warn("429", $"Limite atingido (429){why}. Parte dos dados está sendo descartada.");
                break;
        }
    }

    /// <summary>Confere a chave ao iniciar: sem isso, uma chave errada só apareceria (ou não) no primeiro erro.</summary>
    public async Task VerifyAsync(HttpClient http, CancellationToken ct)
    {
        var endpoint = _options.Endpoint ?? "";
        if (!_options.CanSend || !endpoint.TrimEnd('/').EndsWith("/ingest/event", StringComparison.Ordinal))
        {
            return;
        }
        var url = endpoint.TrimEnd('/')[..^"/ingest/event".Length] + "/ingest/ping";
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.Add("X-FaroHQ-Key", _options.Key);
            using var response = await http.SendAsync(request, ct);
            await CheckAsync(response);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
        }
        catch (Exception e)
        {
            Warn("net", $"Não foi possível falar com o FaroHQ ({url}): {e.Message}.");
        }
    }

    private void Warn(string code, string message)
    {
        lock (_warned)
        {
            if (!_warned.Add(code))
            {
                return;
            }
        }
        try
        {
            Console.Error.WriteLine("[FaroHQ] " + message);
        }
        catch
        {
            // sem stderr: nada a fazer
        }
    }
}
