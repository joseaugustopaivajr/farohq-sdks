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
      received.push({ key: req.headers["x-farohq-key"], body: JSON.parse(data) });
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
