using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace FaroHQ.AspNetCore;

/// <summary>
/// Transforma logs de nível Error/Critical em eventos do FaroHQ (os de nível menor viram o rastro) — pega também erros de
/// background services, filas e qualquer código que só faz _logger.LogError(ex, ...).
/// </summary>
[ProviderAlias("FaroHQ")]
internal sealed class FaroHQLoggerProvider : ILoggerProvider
{
    private readonly FaroHQClient _client;
    private readonly FaroHQOptions _options;
    private readonly FaroHQLogQueue _logs;
    private readonly string? _service;

    public FaroHQLoggerProvider(IFaroHQClient client, IOptions<FaroHQOptions> options, FaroHQLogQueue logs)
    {
        _client = (FaroHQClient)client;
        _options = options.Value;
        _logs = logs;
        _service = _options.Service ?? System.Reflection.Assembly.GetEntryAssembly()?.GetName().Name;
    }

    public ILogger CreateLogger(string categoryName) => new FaroHQLogger(categoryName, _client, _options, _logs, _service);

    public void Dispose()
    {
    }

    private sealed class FaroHQLogger : ILogger
    {
        private readonly string _category;
        private readonly FaroHQClient _client;
        private readonly FaroHQOptions _options;
        private readonly FaroHQLogQueue _logs;
        private readonly string? _service;

        public FaroHQLogger(string category, FaroHQClient client, FaroHQOptions options, FaroHQLogQueue logs, string? service)
        {
            _category = category;
            _client = client;
            _options = options;
            _logs = logs;
            _service = service;
        }

        private bool Ships(LogLevel level) => _options.ShipLogs && _options.CanSend && level >= _options.LogsLevel;

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        // Logs do próprio envio ficam de fora (evita laço infinito se o FaroHQ estiver fora do ar)
        public bool IsEnabled(LogLevel logLevel) =>
            (logLevel >= (_options.MaxBreadcrumbs > 0 && _options.BreadcrumbLevel < _options.MinimumLevel
                ? _options.BreadcrumbLevel : _options.MinimumLevel) || Ships(logLevel))
            && logLevel != LogLevel.None
            && !_category.StartsWith("FaroHQ.", StringComparison.Ordinal)
            && !_category.StartsWith("System.Net.Http.HttpClient." + FaroHQSender.HttpClientName, StringComparison.Ordinal);

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel))
            {
                return;
            }
            var text = formatter(state, exception);
            if (Ships(logLevel))
            {
                var msg = exception is null ? text : $"{text}\n{exception.GetType().FullName}: {exception.Message}";
                _logs.Channel.Writer.TryWrite(new FaroHQLogLine(DateTimeOffset.UtcNow, logLevel.ToString(), _category,
                    msg.Length > 32_000 ? msg[..32_000] : msg, _service, _options.Environment, _options.Release,
                    FaroHQBreadcrumbs.TraceId));
            }
            if (logLevel < _options.MinimumLevel)
            {
                if (_options.MaxBreadcrumbs > 0 && logLevel >= _options.BreadcrumbLevel)
                {
                    FaroHQBreadcrumbs.Add(text, logLevel.ToString(), _category);
                }
                return;
            }
            _client.Enqueue(formatter(state, exception), exception, new Dictionary<string, string?>
            {
                ["logger"] = _category,
                ["eventId"] = eventId.Id == 0 ? null : eventId.ToString(),
            });
        }
    }
}
