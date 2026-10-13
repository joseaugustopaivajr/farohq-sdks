# @farohqbr/browser

Monitoramento do front para o [FaroHQ](https://farohq.com.br):

- **Erros de JavaScript** (inclusive promises rejeitadas), com o **código original** via source maps.
- **O que o usuário fez antes do erro:** cliques, navegação, chamadas à API (com status e tempo) e console.
  Valores de campos (senha, cartão...) nunca são lidos.
- **Front ligado ao back:** as chamadas para a sua API levam o header `traceparent`; o erro do navegador
  aparece junto com o erro e os logs daquela requisição no backend.
- **Desempenho real das páginas:** LCP, INP, CLS, FCP e TTFB (p75, como o Google mede), visualizações e sessões.

Sem dependências. Nada aqui quebra o site: toda captura é protegida e o envio é em segundo plano
(`sendBeacon`).

## Instalar

```bash
npm install @farohqbr/browser
```

```ts
import * as farohq from "@farohqbr/browser";

farohq.init({
  publicKey: "farohq_pk_...",            // chave PÚBLICA do projeto (pode ir no código do site)
  release: process.env.NEXT_PUBLIC_GIT_SHA, // a mesma versão do upload dos source maps
  environment: "production",
  tracePropagationTargets: ["https://api.suaempresa.com.br"], // liga o erro do front ao backend
});
```

Sem bundler:

```html
<script src="https://unpkg.com/@farohqbr/browser/dist/farohq.global.js"></script>
<script>FaroHQ.init({ publicKey: "farohq_pk_..." });</script>
```

Cadastre os domínios do site em **Configurações do projeto → Navegador** (a chave só funciona neles).
A sua API precisa aceitar o header `traceparent` no CORS.

## Source maps

Ligue os source maps no build (Next: `productionBrowserSourceMaps: true`; Vite: `build.sourcemap: true`)
e envie depois do build, com a chave **secreta** do projeto (só no CI):

```bash
FAROHQ_KEY=farohq_... npx farohq-sourcemaps upload .next/static --url-prefix /_next/static --release $GIT_SHA --delete
```

`--delete` apaga os `.map` depois do envio, para o código-fonte não ficar público no site.

## API

| Função | Para quê |
|---|---|
| `init(options)` | Liga tudo. Opções: `publicKey`, `endpoint`, `release`, `environment`, `service`, `tracePropagationTargets`, `maxBreadcrumbs`, `captureConsole`, `rum`, `rumSampleRate`, `shipLogs`, `beforeSend` |
| `captureException(err, extra?)` | Envia um erro tratado |
| `captureMessage(msg, extra?)` | Envia uma mensagem como erro |
| `addBreadcrumb(msg, level?, logger?)` | Adiciona uma linha ao rastro |
| `setContext(key, value)` | Contexto extra em todo erro (evite dados pessoais) |
| `log(level, msg, attrs?)` | Linha para o módulo de Logs (com `shipLogs: true`) |
| `flush()` | Envia na hora o que estiver na fila |

Licença MIT.
