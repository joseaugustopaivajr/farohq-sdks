using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace FaroHQ.AspNetCore;

/// <summary>
/// Transforma logs de nível Error/Critical em eventos do Faro — pega também erros de
/// background services, filas e qualquer código que só faz _logger.LogError(ex, ...).
/// </summary>
[ProviderAlias("FaroHQ")]
internal sealed class FaroHQLoggerProvider : ILoggerProvider
{
    private readonly FaroHQClient _client;
    private readonly FaroHQOptions _options;

    public FaroHQLoggerProvider(IFaroHQClient client, IOptions<FaroHQOptions> options)
    {
        _client = (FaroHQClient)client;
        _options = options.Value;
    }

    public ILogger CreateLogger(string categoryName) => new FaroHQLogger(categoryName, _client, _options);

    public void Dispose()
    {
    }

    private sealed class FaroHQLogger : ILogger
    {
        private readonly string _category;
        private readonly FaroHQClient _client;
        private readonly FaroHQOptions _options;

        public FaroHQLogger(string category, FaroHQClient client, FaroHQOptions options)
        {
            _category = category;
            _client = client;
            _options = options;
        }

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        // Logs do próprio envio ficam de fora (evita laço infinito se o Faro estiver fora do ar)
        public bool IsEnabled(LogLevel logLevel) =>
            logLevel >= _options.MinimumLevel
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
            _client.Enqueue(formatter(state, exception), exception, new Dictionary<string, string?>
            {
                ["logger"] = _category,
                ["eventId"] = eventId.Id == 0 ? null : eventId.ToString(),
            });
        }
    }
}
