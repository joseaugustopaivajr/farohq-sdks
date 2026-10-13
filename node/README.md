# @farohqbr/node

Envia os erros de aplicações Node.js (Express, Next.js, Fastify, workers) para o
[FaroHQ](https://farohq.com.br), que agrupa, tria e analisa a causa raiz lendo o seu código.

```bash
npm install @farohqbr/node
```

```js
const farohq = require("@farohqbr/node");

farohq.init({ service: "minha-api" }); // chave em FAROHQ_KEY

// Express: depois das rotas
app.use(farohq.expressErrorHandler());
```

**Next.js 15+** (`instrumentation.ts` na raiz):

```ts
export { onRequestError } from "@farohqbr/node";
```

Erros tratados:

```js
try { await fecharPedido(42); } catch (err) { farohq.captureException(err, { pedido: 42 }); }
```

| Variável | Para quê |
|---|---|
| `FAROHQ_KEY` | Chave de ingestão do projeto (obrigatória) |
| `FAROHQ_ENV` | Ambiente (padrão `NODE_ENV` ou `production`) |
| `GIT_SHA` | Commit do deploy: é com ele que o FaroHQ lê o código certo |
| `FAROHQ_ENDPOINT` | Só para ambientes self-hosted |

`init()` também captura `unhandledRejection` e `uncaughtException` (sem mudar o comportamento
padrão do Node). Sem dependências: usa o `fetch` nativo do Node 18+. Em scripts e lambdas,
chame `await farohq.flush()` antes de encerrar.

## Logs (opcional)

Além dos erros, o FaroHQ guarda os logs da aplicação: busca, filtros, ao vivo e a requisição
inteira (pelo traceId) ao lado do erro. Para ligar, defina `FAROHQ_LOGS=true`. As linhas vão em
lote, a cada 2 segundos, numa thread de fundo; com o FaroHQ fora do ar, elas são descartadas e a
aplicação segue normalmente. O pacote grátis inclui 1 GB por mês, guardado por 3 dias.

`farohq.init({ shipLogs: true })` envia o `console.*`; para logs estruturados use
`farohq.log("info", "Pedido pago", { pedido: 42 })`.
