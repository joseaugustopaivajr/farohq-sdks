# Publicar os SDKs

Os pacotes saem deste repositório para os registros públicos, onde os clientes instalam:

| Pacote | Registro | Instalação do cliente |
|---|---|---|
| Java / Kotlin (`java/`) | Maven Central | `implementation("br.com.farohq:farohq-java:VERSÃO")` |
| Node.js (`node/`) | npm | `npm install @farohqbr/node` |
| Navegador (`browser/`) | npm | `npm install @farohqbr/browser` |
| Python (`python/`) | PyPI | `pip install farohq` |
| .NET (`dotnet/`) | NuGet | `dotnet add package FaroHQ.AspNetCore` |

## Como publicar

### Pelo GitHub (recomendado)

1. **Actions → "Publicar SDKs" → Run workflow**.
2. Em **pacote**, escolha um (`java`, `node`, `browser`, `python`, `dotnet`) ou `todos`.
3. Em **versão**, deixe vazio para usar a versão que está no arquivo do pacote, ou digite uma
   (ex.: `0.3.0`).
4. **Run workflow**. Cada pacote roda os testes antes de publicar; se um teste falhar, aquele pacote
   não sai. O resumo da execução mostra o link e o comando de instalação.

### Por tag (alternativa)

```bash
git tag java-v0.3.0 && git push origin java-v0.3.0      # também: node-v, browser-v, python-v, dotnet-v
```

A versão vem da tag.

### Antes de publicar uma versão nova

1. Suba o número da versão no arquivo do pacote (é o que vale com o campo **versão** vazio):

   | Pacote | Arquivo | Campo |
   |---|---|---|
   | Java | `java/gradle.properties` | `VERSION_NAME` |
   | Node / Navegador | `node/package.json` / `browser/package.json` | `version` |
   | Python | `python/pyproject.toml` e `python/src/farohq/__init__.py` | `version` / `__version__` |
   | .NET | `dotnet/src/FaroHQ.AspNetCore/FaroHQ.AspNetCore.csproj` | `<Version>` |

   Atualize também o `User-Agent` (`farohq-java/X.Y.Z` etc.) se quiser ver a versão nos logs da API.

2. Rode os testes localmente (os mesmos do workflow):

   ```bash
   (cd java && ./gradlew test) && (cd node && npm test) && (cd browser && npm test)
   (cd python && python3 -m unittest discover -s tests) && ~/.dotnet/dotnet build dotnet/samples/FaroHQ.Sample
   ```

3. Faça o commit na `main` e publique.

**Uma versão publicada não pode ser apagada nem reaproveitada** em nenhum dos registros: para corrigir,
publique a próxima (ex.: `0.2.1`). Siga [SemVer](https://semver.org/lang/pt-BR/): correção = último
número, novidade compatível = do meio, quebra de compatibilidade = primeiro.

## Configuração única (já feita / a fazer)

Cada registro precisa de uma conta do FaroHQ e de um segredo no GitHub
(**Settings → Secrets and variables → Actions**). Os comandos abaixo usam o `gh` no seu terminal.

### Maven Central (Java/Kotlin)

1. Entre em <https://central.sonatype.com> (dá para entrar com o GitHub).
2. **Namespaces → Add namespace → `br.com.farohq`**. O portal mostra um código de verificação:
   crie um registro **TXT** em `farohq.com.br` (na GoDaddy) com esse código e clique em **Verify**.
3. **Account → Generate User Token**. Cadastre os dois valores:

   ```bash
   gh secret set MAVEN_CENTRAL_USERNAME -R joseaugustopaivajr/farohq-sdks   # cola o "username" do token
   gh secret set MAVEN_CENTRAL_PASSWORD -R joseaugustopaivajr/farohq-sdks   # cola o "password" do token
   ```

4. Chave de assinatura (o Maven Central exige pacotes assinados). A chave **já foi gerada** e a parte
   pública já está em `keyserver.ubuntu.com`. Ela fica em `~/.farohq-release/` no Mac do José
   (faça backup num cofre de senhas):

   | Arquivo | O que é |
   |---|---|
   | `signing-key.asc` | Chave privada (nunca versionar) |
   | `signing-key-passphrase.txt` | Senha da chave |
   | `signing-key-public.asc` | Chave pública |
   | `fingerprint.txt` | Identificação: `1F339A3AB7710CFDD6F95BCB96D5A5F26908E3A4` |

   ```bash
   gh secret set SIGNING_KEY -R joseaugustopaivajr/farohq-sdks < ~/.farohq-release/signing-key.asc
   gh secret set SIGNING_KEY_PASSWORD -R joseaugustopaivajr/farohq-sdks < ~/.farohq-release/signing-key-passphrase.txt
   ```

   A chave vence em 2031. Para renovar: `gpg --quick-set-expire <fingerprint> 5y`, depois
   `gpg --keyserver hkps://keyserver.ubuntu.com --send-keys <fingerprint>`.

### npm (Node e Navegador)

1. Crie a conta em <https://www.npmjs.com> e a organização **`farohqbr`** (o escopo `@farohq` pertence a outra empresa) (plano grátis, pacotes públicos).
2. **Access Tokens → Generate New Token → Granular**: permissão **Read and write** só para a
   organização `farohqbr`, validade longa.
3. ```bash
   gh secret set NPM_TOKEN -R joseaugustopaivajr/farohq-sdks
   ```

Os pacotes saem com **provenance** (selo do npm de que vieram deste repositório público, por este
workflow).

### PyPI (Python)

Não usa token: o PyPI confia no GitHub (Trusted Publishing).

1. Crie a conta em <https://pypi.org> (ative o 2FA, é obrigatório).
2. **Your projects → Publishing → Add a new pending publisher → GitHub**:

   | Campo | Valor |
   |---|---|
   | PyPI Project Name | `farohq` |
   | Owner | `joseaugustopaivajr` |
   | Repository name | `farohq-sdks` |
   | Workflow name | `publicar.yml` |
   | Environment name | `pypi` |

O ambiente `pypi` já existe no GitHub e só aceita publicação a partir da `main` ou de tags `python-v*`.

### NuGet (.NET)

Também não usa chave guardada: o NuGet confia no GitHub (Trusted Publishing) e a action pega uma
chave temporária, válida por 1 hora, na hora de publicar.

1. Entre em <https://www.nuget.org> com uma conta Microsoft.
2. **Seu usuário → Trusted Publishing → Add a new policy**:

   | Campo | Valor |
   |---|---|
   | Repository Owner | `joseaugustopaivajr` |
   | Repository | `farohq-sdks` |
   | Workflow File | `publicar.yml` |
   | Environment | (vazio) |

3. Informe o **nome de usuário** do NuGet (o do perfil, não o e-mail) numa variável do repositório:
   ```bash
   gh variable set NUGET_USER -R joseaugustopaivajr/farohq-sdks --body "SEU_USUARIO_NUGET"
   ```

## Conferir os segredos

```bash
gh secret list -R joseaugustopaivajr/farohq-sdks
```

Devem aparecer: `MAVEN_CENTRAL_USERNAME`, `MAVEN_CENTRAL_PASSWORD`, `SIGNING_KEY`,
`SIGNING_KEY_PASSWORD`, `NPM_TOKEN` e `NUGET_API_KEY` (o PyPI não usa segredo).

## Problemas comuns

| Erro | Causa provável |
|---|---|
| Maven: `namespace not verified` | O TXT do Maven Central ainda não está no DNS de `farohq.com.br` |
| Maven: `Invalid signature` / `Could not find a public key` | A chave pública não está no keyserver: reenvie com `--send-keys` |
| npm: `403 Forbidden` | Token sem permissão de escrita na organização `farohqbr`, ou versão já publicada |
| npm: `provenance ... private repository` | O repositório deixou de ser público |
| PyPI: `invalid-publisher` | Algum campo do pending publisher não bate (workflow tem que ser `publicar.yml`, ambiente `pypi`) |
| NuGet: `409 Conflict` | Versão já publicada (o workflow ignora com `--skip-duplicate`, suba a versão) |
