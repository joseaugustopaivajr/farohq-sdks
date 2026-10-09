# @farohq/node

Envia os erros de aplicações Node.js (Express, Next.js, Fastify, workers) para o
[FaroHQ](https://farohq.com.br), que agrupa, tria e analisa a causa raiz com IA lendo o seu código.

```bash
npm install @farohq/node
```

```js
const farohq = require("@farohq/node");

farohq.init({ service: "minha-api" }); // chave em FAROHQ_KEY

// Express: depois das rotas
app.use(farohq.expressErrorHandler());
```

**Next.js 15+** (`instrumentation.ts` na raiz):

```ts
export { onRequestError } from "@farohq/node";
```

Erros tratados:

```js
try { await fecharPedido(42); } catch (err) { farohq.captureException(err, { pedido: 42 }); }
```

| Variável | Para quê |
|---|---|
| `FAROHQ_KEY` | Chave de ingestão do projeto (obrigatória) |
| `FAROHQ_ENV` | Ambiente (padrão `NODE_ENV` ou `production`) |
| `GIT_SHA` | Commit do deploy: é com ele que a IA lê o código certo |
| `FAROHQ_ENDPOINT` | Só para ambientes self-hosted |

`init()` também captura `unhandledRejection` e `uncaughtException` (sem mudar o comportamento
padrão do Node). Sem dependências: usa o `fetch` nativo do Node 18+. Em scripts e lambdas,
chame `await farohq.flush()` antes de encerrar.
