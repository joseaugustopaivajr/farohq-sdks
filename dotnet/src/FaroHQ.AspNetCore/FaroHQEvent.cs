using System.Text.Json.Serialization;

namespace FaroHQ.AspNetCore;

/// <summary>Formato aceito por POST /ingest/event.</summary>
internal sealed record FaroHQEvent(
    [property: JsonPropertyName("level")] string Level,
    [property: JsonPropertyName("environment")] string? Environment,
    [property: JsonPropertyName("release")] string? Release,
    [property: JsonPropertyName("service")] string? Service,
    [property: JsonPropertyName("message")] string? Message,
    [property: JsonPropertyName("timestamp")] DateTimeOffset Timestamp,
    [property: JsonPropertyName("exception")] FaroHQException? Exception,
    [property: JsonPropertyName("context")] IReadOnlyDictionary<string, string?>? Context);

internal sealed record FaroHQException(
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("message")] string Message,
    [property: JsonPropertyName("stacktrace")] string Stacktrace);
