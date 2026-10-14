# FaroHQ.AspNetCore

Envia os erros de aplicações ASP.NET Core (.NET 8+) para o FaroHQ.

O que captura:
- **Exceções não tratadas das requisições** (middleware), com rota, método e traceId.
- **Todo log de nível Error/Critical** (`_logger.LogError(ex, ...)`), inclusive de background services.
- **Captura manual** via `IFaroHQClient`, para erros tratados.

Não bloqueia a requisição (fila em memória + envio em segundo plano) e nunca lança exceção.

## Instalação

```bash
dotnet add package FaroHQ.AspNetCore
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
  "Service": "minha-api"
}
```

| Variável | Para quê |
|---|---|
| `FAROHQ_KEY` | Chave de ingestão do projeto (obrigatória; sem ela nada é enviado) |
| `FAROHQ_ENDPOINT` | URL de ingestão |
| `FAROHQ_ENV` | Ambiente (padrão: `ASPNETCORE_ENVIRONMENT`) |
| `GIT_SHA` | Commit do deploy: é com ele que o FaroHQ lê o código certo |

## Exemplo

```bash
cd samples/FaroHQ.Sample
FAROHQ_KEY=farohq_... dotnet run --urls http://localhost:5090
curl http://localhost:5090/pedidos/42/fechar   # NullReferenceException não tratada
curl http://localhost:5090/log-erro            # FormatException logada
curl http://localhost:5090/captura-manual      # captura manual
```

## Logs (opcional)

Além dos erros, o FaroHQ guarda os logs da aplicação: busca, filtros, ao vivo e a requisição
inteira (pelo traceId) ao lado do erro. Para ligar, defina `FAROHQ_LOGS=true`. As linhas vão em
lote, a cada 2 segundos, numa thread de fundo; com o FaroHQ fora do ar, elas são descartadas e a
aplicação segue normalmente. O pacote grátis inclui 1 GB por mês, guardado por 3 dias.

No `appsettings.json`: `"FaroHQ": { "ShipLogs": true, "LogsLevel": "Information" }`.
