using System.Reflection;
using System.Threading.Channels;
using Microsoft.Extensions.Options;

namespace FaroHQ.AspNetCore;

/// <summary>
/// Enfileira eventos em memória; quem envia é o <see cref="FaroHQSender"/> em segundo plano.
/// Capturar um erro nunca bloqueia a requisição nem lança exceção.
/// </summary>
internal sealed class FaroHQClient : IFaroHQClient
{
    /// <summary>Marca a exceção já enviada pelo middleware, para o logger não mandar de novo.</summary>
    internal const string CapturedKey = "farohq:captured";

    private readonly Channel<FaroHQEvent> _queue;
    private readonly FaroHQOptions _options;
    private readonly string? _service;

    public FaroHQClient(Channel<FaroHQEvent> queue, IOptions<FaroHQOptions> options)
    {
        _queue = queue;
        _options = options.Value;
        _service = _options.Service ?? Assembly.GetEntryAssembly()?.GetName().Name;
    }

    public void CaptureException(Exception exception, IReadOnlyDictionary<string, string?>? context = null)
        => Enqueue(null, exception, context);

    public void CaptureMessage(string message, IReadOnlyDictionary<string, string?>? context = null)
        => Enqueue(message, null, context);

    internal void Enqueue(string? message, Exception? exception, IReadOnlyDictionary<string, string?>? context)
    {
        if (!_options.CanSend)
        {
            return;
        }
        try
        {
            if (exception is not null)
            {
                if (exception.Data.Contains(CapturedKey))
                {
                    return;
                }
                exception.Data[CapturedKey] = true;
            }
            var evt = new FaroHQEvent(
                Level: "error",
                Environment: _options.Environment,
                Release: _options.Release,
                Service: _service,
                Message: message ?? exception?.Message,
                Timestamp: DateTimeOffset.UtcNow,
                Exception: exception is null
                    ? null
                    : new FaroHQException(exception.GetType().FullName ?? exception.GetType().Name, exception.Message, exception.ToString()),
                Context: context);
            _queue.Writer.TryWrite(evt);
        }
        catch
        {
            // Reportar erro nunca pode derrubar a aplicação
        }
    }
}
