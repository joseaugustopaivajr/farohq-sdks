using System.Threading.Channels;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace FaroHQ.AspNetCore;

public static class FaroHQExtensions
{
    /// <summary>
    /// Registra o FaroHQ: logger de erros, fila em segundo plano e <see cref="IFaroHQClient"/>.
    /// Lê a seção "FaroHQ" da configuração e as variáveis FAROHQ_KEY, FAROHQ_ENDPOINT, FAROHQ_ENV e GIT_SHA.
    /// </summary>
    public static IServiceCollection AddFaroHQ(this IServiceCollection services, IConfiguration configuration,
        Action<FaroHQOptions>? configure = null)
    {
        services.AddOptions<FaroHQOptions>()
            .Bind(configuration.GetSection("FaroHQ"))
            .PostConfigure(o =>
            {
                o.Key = Env("FAROHQ_KEY") ?? o.Key;
                o.Endpoint = Env("FAROHQ_ENDPOINT") ?? o.Endpoint;
                o.Environment = Env("FAROHQ_ENV") ?? o.Environment ?? Env("ASPNETCORE_ENVIRONMENT") ?? "production";
                o.Release = Env("GIT_SHA") ?? o.Release;
                o.ShipLogs = Env("FAROHQ_LOGS") == "true" || o.ShipLogs;
                configure?.Invoke(o);
            });

        services.AddHttpClient(FaroHQSender.HttpClientName, c => c.Timeout = TimeSpan.FromSeconds(10));
        services.AddSingleton(sp =>
        {
            var capacity = configuration.GetValue("FaroHQ:QueueCapacity", 1000);
            return Channel.CreateBounded<FaroHQEvent>(new BoundedChannelOptions(capacity)
            {
                FullMode = BoundedChannelFullMode.DropWrite,
                SingleReader = true,
            });
        });
        services.AddSingleton<IFaroHQClient, FaroHQClient>();
        services.AddHostedService<FaroHQSender>();
        services.AddSingleton<FaroHQLogQueue>();
        services.AddHostedService<FaroHQLogShipper>();
        services.AddSingleton<ILoggerProvider, FaroHQLoggerProvider>();
        return services;
    }

    /// <summary>Captura exceções não tratadas das requisições. Coloque logo no começo do pipeline.</summary>
    public static IApplicationBuilder UseFaroHQ(this IApplicationBuilder app) => app.UseMiddleware<FaroHQMiddleware>();

    private static string? Env(string name)
    {
        var v = System.Environment.GetEnvironmentVariable(name);
        return string.IsNullOrWhiteSpace(v) ? null : v;
    }
}
