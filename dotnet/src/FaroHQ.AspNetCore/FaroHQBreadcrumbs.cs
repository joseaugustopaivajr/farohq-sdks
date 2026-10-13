using System.Diagnostics;

namespace FaroHQ.AspNetCore;

/// <summary>
/// O rastro (últimos logs) da requisição atual. O middleware abre um rastro por requisição
/// (AsyncLocal atravessa os awaits); fora de requisição, vale um rastro compartilhado dos últimos minutos.
/// </summary>
public static class FaroHQBreadcrumbs
{
    private static readonly TimeSpan SharedMaxAge = TimeSpan.FromMinutes(5);
    private static readonly AsyncLocal<Trail?> Current = new();
    private static readonly Trail Shared = new(null);

    internal static int Max { get; set; } = 30;

    internal sealed class Trail
    {
        public Trail(string? traceId) => TraceId = traceId;

        public string? TraceId { get; }

        public Queue<FaroHQBreadcrumb> Crumbs { get; } = new();
    }

    /// <summary>Guarda uma linha no rastro atual; vai junto com o próximo erro.</summary>
    public static void Add(string message, string level = "Information", string? logger = null)
    {
        if (Max <= 0)
        {
            return;
        }
        var trail = Current.Value ?? Shared;
        if (message.Length > 1000)
        {
            message = message[..1000];
        }
        lock (trail)
        {
            trail.Crumbs.Enqueue(new FaroHQBreadcrumb(DateTimeOffset.UtcNow, level, logger, message));
            while (trail.Crumbs.Count > Max)
            {
                trail.Crumbs.Dequeue();
            }
        }
    }

    /// <summary>Abre um rastro próprio (uma requisição, um job). Descarte o retorno para fechar.</summary>
    public static IDisposable BeginScope(string? traceId = null)
    {
        var previous = Current.Value;
        Current.Value = new Trail(traceId ?? Activity.Current?.TraceId.ToHexString());
        return new Restore(previous);
    }

    internal static string? TraceId => Current.Value?.TraceId ?? Activity.Current?.TraceId.ToHexString();

    internal static IReadOnlyList<FaroHQBreadcrumb>? Snapshot()
    {
        var trail = Current.Value;
        var cutoff = DateTimeOffset.MinValue;
        if (trail is null)
        {
            trail = Shared;
            cutoff = DateTimeOffset.UtcNow - SharedMaxAge;
        }
        lock (trail)
        {
            var list = trail.Crumbs.Where(c => c.Timestamp >= cutoff).ToList();
            return list.Count == 0 ? null : list;
        }
    }

    private sealed class Restore : IDisposable
    {
        private readonly Trail? _previous;

        public Restore(Trail? previous) => _previous = previous;

        public void Dispose() => Current.Value = _previous;
    }
}
