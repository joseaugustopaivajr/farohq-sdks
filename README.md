# SDKs do FaroHQ

| Linguagem | Pacote | Pasta |
|---|---|---|
| Java (Spring Boot, Logback) | `br.com.farohq:farohq-java` (Maven Central) | `java/` |
| Node.js (Express, Next.js) | `@farohq/node` (npm) | `node/` |
| Python (Django, Flask, FastAPI) | `farohq` (PyPI) | `python/` |
| .NET (ASP.NET Core) | `FaroHQ.AspNetCore` (NuGet) | `dotnet/` |
| Navegador (React, Next, Vue...) | `@farohq/browser` (npm) | `browser/` |

Todas seguem o mesmo contrato: `POST /ingest/event` com o header `X-FaroHQ-Key`, fila em memória,
envio em segundo plano, nunca derrubam a aplicação e não têm dependências obrigatórias.
Configuração por variável de ambiente: `FAROHQ_KEY`, `FAROHQ_ENV`, `GIT_SHA`, `FAROHQ_ENDPOINT`.
Com `FAROHQ_LOGS=true`, enviam também os logs para o módulo de Logs (`POST /ingest/logs`).

O pacote do navegador usa a chave **pública** do projeto (`farohq_pk_...`, restrita aos domínios
cadastrados) e envia para `/ingest/browser/*`; o upload de source maps (`farohq-sourcemaps`) usa a
chave secreta, só no build.

## Publicar uma versão

Pelo GitHub: **Actions → "Publicar SDKs" → Run workflow** (escolha o pacote ou `todos`).
Contas, segredos, versões e problemas comuns: **[PUBLICACAO.md](PUBLICACAO.md)**.
