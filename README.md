# SDKs do FaroHQ

| Linguagem | Pacote | Pasta |
|---|---|---|
| Java (Spring Boot, Logback) | `br.com.farohq:farohq-java` (Maven Central) | `java/` |
| Node.js (Express, Next.js) | `@farohq/node` (npm) | `node/` |
| Python (Django, Flask, FastAPI) | `farohq` (PyPI) | `python/` |
| .NET (ASP.NET Core) | `FaroHQ.AspNetCore` (NuGet) | `dotnet/` |

Todas seguem o mesmo contrato: `POST /ingest/event` com o header `X-FaroHQ-Key`, fila em memória,
envio em segundo plano, nunca derrubam a aplicação e não têm dependências obrigatórias.
Configuração por variável de ambiente: `FAROHQ_KEY`, `FAROHQ_ENV`, `GIT_SHA`, `FAROHQ_ENDPOINT`.

## Publicar uma versão

Crie a tag e o GitHub Actions publica (`.github/workflows/release-*.yml`):

```bash
git tag java-v0.1.0 && git push origin java-v0.1.0
git tag node-v0.1.0 && git push origin node-v0.1.0
git tag python-v0.1.0 && git push origin python-v0.1.0
git tag dotnet-v0.1.0 && git push origin dotnet-v0.1.0
```

Segredos do repositório:

| Registro | O que configurar |
|---|---|
| Maven Central | Conta em central.sonatype.com, namespace `br.com.farohq` verificado por TXT no DNS de farohq.com.br, token (`MAVEN_CENTRAL_USERNAME`/`MAVEN_CENTRAL_PASSWORD`) e chave GPG (`SIGNING_KEY`/`SIGNING_KEY_PASSWORD`) |
| npm | Organização `farohq` no npmjs.com e `NPM_TOKEN` (granular, só publicação) |
| PyPI | Projeto `farohq` com *Trusted Publisher* apontando para este repositório e o workflow `release-python.yml` (ambiente `pypi`) — sem token |
| NuGet | Conta em nuget.org, prefixo `FaroHQ` reservado (opcional) e `NUGET_API_KEY` com escopo de push |

## Rodar os testes

```bash
cd java && ./gradlew test
cd node && npm test
cd python && python3 -m unittest discover -s tests
cd dotnet && dotnet build samples/FaroHQ.Sample
```
