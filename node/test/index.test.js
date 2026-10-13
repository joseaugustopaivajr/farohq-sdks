const { test } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const farohq = require("../dist/index.js");

function server() {
  const received = [];
  const srv = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      received.push({ key: req.headers["x-farohq-key"], path: req.url, body: JSON.parse(data) });
      res.writeHead(202).end();
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, received, url: `http://127.0.0.1:${srv.address().port}/ingest` })));
}

test("envia exceção com chave, stack e contexto", async () => {
  const { srv, received, url } = await server();
  farohq.init({ key: "farohq_teste", endpoint: url, service: "loja", release: "abc123", captureUnhandled: false });
  const err = new TypeError("Cannot read properties of undefined (reading 'total')");
  await farohq.captureException(err, { path: "/checkout" });
  await farohq.captureException(err); // mesma exceção não vai duas vezes
  await farohq.flush();
  srv.close();
  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].key, "farohq_teste");
  const b = received[0].body;
  assert.strictEqual(b.exception.type, "TypeError");
  assert.match(b.exception.stacktrace, /index\.test\.js/);
  assert.strictEqual(b.context.path, "/checkout");
  assert.strictEqual(b.release, "abc123");
  assert.strictEqual(b.service, "loja");
});

test("middleware do Express captura e repassa o erro", async () => {
  const { srv, received, url } = await server();
  farohq.init({ key: "k", endpoint: url, captureUnhandled: false });
  const mw = farohq.expressErrorHandler();
  let forwarded;
  mw(new Error("falhou"), { originalUrl: "/pedidos/42", method: "POST" }, {}, (e) => (forwarded = e));
  await farohq.flush();
  srv.close();
  assert.strictEqual(forwarded.message, "falhou");
  assert.strictEqual(received[0].body.context.method, "POST");
});

test("sem chave não envia e não quebra", async () => {
  farohq.init({ key: undefined, endpoint: "http://127.0.0.1:1/nada", captureUnhandled: false });
  delete process.env.FAROHQ_KEY;
  await farohq.captureException(new Error("x"));
});

test("endpoint fora do ar não lança", async () => {
  farohq.init({ key: "k", endpoint: "http://127.0.0.1:1/fora", captureUnhandled: false });
  await farohq.captureException(new Error("x"));
});

test("leva o rastro da requisição e o traceId", async () => {
  const { srv, received, url } = await server();
  farohq.init({ key: "k", endpoint: url, captureUnhandled: false, captureConsole: true });
  console.log("fora da requisição");
  const mw = farohq.expressRequestHandler();
  await new Promise((done) =>
    mw({ headers: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" } }, {}, async () => {
      console.info("POST /checkout pedido %d", 42);
      farohq.addBreadcrumb("estoque baixo", "WARN", "estoque");
      await new Promise((r) => setTimeout(r, 5)); // atravessa o await
      await farohq.captureException(new Error("sem itens"));
      done();
    })
  );
  await farohq.flush();
  srv.close();
  const b = received[0].body;
  assert.strictEqual(b.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.deepStrictEqual(b.breadcrumbs.map((c) => c.message), ["POST /checkout pedido 42", "estoque baixo"]);
  assert.strictEqual(b.breadcrumbs[1].level, "WARN");
});

test("com shipLogs envia console e farohq.log em lote para /ingest/logs", async () => {
  const { srv, received, url } = await server();
  farohq.init({ key: "k", endpoint: url.replace(/ingest$/, "ingest/event"), service: "loja", captureUnhandled: false, shipLogs: true });
  const mw = farohq.expressRequestHandler();
  await new Promise((done) =>
    mw({ headers: { "x-request-id": "req-9" } }, {}, () => {
      console.debug("debug fica de fora");
      console.info("Pedido %d pago", 7);
      farohq.log("warn", "Estoque baixo", { sku: 123 });
      done();
    })
  );
  await farohq.flush();
  srv.close();
  const logs = received.filter((r) => r.path.endsWith("/ingest/logs")).flatMap((r) => r.body);
  assert.deepStrictEqual(logs.map((l) => l.message), ["Pedido 7 pago", "Estoque baixo"]);
  assert.strictEqual(logs[0].traceId, "req-9");
  assert.strictEqual(logs[1].level, "WARN");
  assert.deepStrictEqual(logs[1].attributes, { sku: 123 });
  assert.strictEqual(logs[0].service, "loja");
});
