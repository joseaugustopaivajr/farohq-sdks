using Microsoft.AspNetCore.Http;

namespace FaroHQ.AspNetCore;

/// <summary>Captura exceções não tratadas das requisições, com rota e método, e deixa seguir.</summary>
internal sealed class FaroHQMiddleware
{
    private readonly RequestDelegate _next;

    public FaroHQMiddleware(RequestDelegate next) => _next = next;

    public async Task InvokeAsync(HttpContext context, IFaroHQClient faro)
    {
        using var scope = FaroHQBreadcrumbs.BeginScope(
            System.Diagnostics.Activity.Current?.TraceId.ToHexString() ?? context.TraceIdentifier);
        try
        {
            await _next(context);
        }
        catch (Exception ex)
        {
            faro.CaptureException(ex, new Dictionary<string, string?>
            {
                ["path"] = context.Request.Path.Value,
                ["method"] = context.Request.Method,
                ["traceId"] = context.TraceIdentifier,
            });
            throw;
        }
    }
}
