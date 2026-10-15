import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const GLOBAL = readFileSync(new URL("../dist/farohq.global.js", import.meta.url), "utf8");

function page() {
  const dom = new JSDOM(`<!doctype html><body><button id="pagar" class="btn primary">Finalizar compra</button>
    <input id="cartao" name="cartao" value="4111111111111111"></body>`, { url: "https://loja.com.br/checkout?cupom=X", runScripts: "outside-only" });
  const w = dom.window;
  const calls = [];
  w.Headers = globalThis.Headers;
  w.URL = globalThis.URL;
  w.fetch = (input, init = {}) => {
    calls.push({ url: String(input), init });
    const status = String(input).includes("/api/pagamento") ? 500 : 202;
    return Promise.resolve({ status, ok: status < 400 });
  };
  w.eval(GLOBAL);
  w.FaroHQ.init({ publicKey: "farohq_pk_teste", endpoint: "https://api.farohq.com.br/api/v1", release: "abc123", environment: "production" });
  pages.push(w);
  return { w, calls };
}

const pages = [];
test.after(() => pages.forEach((w) => w.close()));

const sent = (calls, kind) => calls.filter((c) => c.url.includes(`/ingest/browser/${kind}`)).map((c) => JSON.parse(c.init.body));

test("erro leva o rastro, a página e o traceId da chamada que falhou", async () => {
  const { w, calls } = page();
  w.document.getElementById("pagar").click();
  w.document.getElementById("cartao").click();
  await w.fetch("/api/pagamento", { method: "POST" });
  w.history.pushState({}, "", "/obrigado");
  w.FaroHQ.captureException(new w.Error("Pagamento recusado"));

  const api = calls.find((c) => c.url === "/api/pagamento");
  const tp = api.init.headers.get("traceparent");
  assert.match(tp, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

  const [ev] = sent(calls, "error");
  assert.strictEqual(ev.message, "Pagamento recusado");
  assert.strictEqual(ev.release, "abc123");
  assert.strictEqual(ev.traceId, tp.split("-")[1]);
  assert.match(ev.url, /\/obrigado$/);
  const msgs = ev.breadcrumbs.map((b) => b.message);
  assert.ok(msgs.some((m) => m.includes("button#pagar.btn.primary 'Finalizar compra'")), msgs.join("|"));
  assert.ok(msgs.some((m) => m.startsWith("Clique em input#cartao")), msgs.join("|"));
  assert.ok(!msgs.join(" ").includes("4111"), "nunca lê valor de campo");
  assert.ok(msgs.some((m) => m.includes("POST /api/pagamento → 500")), msgs.join("|"));
  assert.ok(msgs.some((m) => m.includes("Navegou de /checkout para /obrigado")), msgs.join("|"));
  assert.ok(calls.every((c) => !c.url.includes("ingest/browser/error") || c.url.includes("key=farohq_pk_teste")));
});

test("não manda traceparent para outros domínios nem para o próprio FaroHQ", async () => {
  const { w, calls } = page();
  await w.fetch("https://cdn.outrosite.com/x.json");
  const other = calls.find((c) => c.url.includes("outrosite"));
  assert.ok(!other.init.headers || !(other.init.headers.get && other.init.headers.get("traceparent")));
});

test("mesmo erro repetido em sequência vai uma vez só", () => {
  const { w, calls } = page();
  for (let i = 0; i < 5; i++) w.FaroHQ.captureException(new w.Error("laço"));
  assert.strictEqual(sent(calls, "error").length, 1);
});

test("erro não tratado da página é capturado", () => {
  const { w, calls } = page();
  const err = new w.Error("x is not defined");
  w.dispatchEvent(new w.ErrorEvent("error", { error: err, message: err.message }));
  assert.strictEqual(sent(calls, "error")[0].exception.message, "x is not defined");
});

test("domínio recusado: avisa uma vez no console e para de enviar", async () => {
  const dom = new JSDOM(`<!doctype html><body></body>`, { url: "https://outro-site.com/", runScripts: "outside-only" });
  const w = dom.window;
  pages.push(w);
  const calls = [];
  const warns = [];
  w.console.warn = (...a) => warns.push(a.join(" "));
  w.URL = globalThis.URL;
  w.fetch = (input) => {
    calls.push(String(input));
    const ping = String(input).includes("/ingest/browser/ping");
    return Promise.resolve({
      status: ping ? 403 : 202,
      ok: !ping,
      json: async () => ({ status: 403, message: "Domínio https://outro-site.com não autorizado para esta chave" }),
    });
  };
  w.navigator.sendBeacon = (url) => {
    calls.push(String(url));
    return true;
  };
  w.eval(GLOBAL);
  w.FaroHQ.init({ publicKey: "farohq_pk_teste", endpoint: "https://api.farohq.com.br/api/v1", rum: false });
  await new Promise((r) => setTimeout(r, 20));
  w.FaroHQ.captureException(new w.Error("depois da recusa"));
  assert.strictEqual(warns.length, 1, warns.join("|"));
  assert.match(warns[0], /\[FaroHQ\] Envio recusado \(403\): Domínio https:\/\/outro-site\.com não autorizado/);
  assert.ok(!calls.some((c) => c.includes("/ingest/browser/error")), calls.join("|"));
});
