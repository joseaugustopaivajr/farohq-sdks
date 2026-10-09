# FaroHQ.AspNetCore

Envia os erros de aplicações ASP.NET Core (.NET 8+) para o FaroHQHQ.

O que captura:
- **Exceções não tratadas das requisições** (middleware), com rota, método e traceId.
- **Todo log de nível Error/Critical** (`_logger.LogError(ex, ...)`), inclusive de background services.
- **Captura manual** via `IFaroHQClient`, para erros tratados.

Não bloqueia a requisição (fila em memória + envio em segundo plano) e nunca lança exceção.

## Instalação (local, enquanto não está no NuGet)

```bash
dotnet add SeuProjeto.csproj reference /caminho/farosdk/dotnet/src/FaroHQ.AspNetCore/FaroHQ.AspNetCore.csproj
```

`Program.cs`:

```csharp
using FaroHQ.AspNetCore;

builder.Services.AddFaroHQ(builder.Configuration);
var app = builder.Build();
app.UseFaroHQ(); // logo no começo do pipeline
```

Configuração (`appsettings.json` ou variáveis de ambiente, que têm prioridade):

```json
"FaroHQ": {
  "Endpoint": "http://localhost:8030/api/v1/ingest/event",
  "Service": "minha-api"
}
```

| Variável | Para quê |
|---|---|
| `FAROHQ_KEY` | Chave de ingestão do projeto (obrigatória; sem ela nada é enviado) |
| `FAROHQ_ENDPOINT` | URL de ingestão |
| `FAROHQ_ENV` | Ambiente (padrão: `ASPNETCORE_ENVIRONMENT`) |
| `GIT_SHA` | Commit do deploy: é com ele que a IA lê o código certo |

## Exemplo

```bash
cd samples/FaroHQ.Sample
FAROHQ_KEY=farohq_... dotnet run --urls http://localhost:5090
curl http://localhost:5090/pedidos/42/fechar   # NullReferenceException não tratada
curl http://localhost:5090/log-erro            # FormatException logada
curl http://localhost:5090/captura-manual      # captura manual
```
