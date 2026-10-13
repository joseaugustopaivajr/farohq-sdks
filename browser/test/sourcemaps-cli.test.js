import { test } from "node:test";
import assert from "node:assert";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";

test("CLI envia cada .map com o caminho do site e apaga com --delete", async () => {
  const got = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      got.push({ url: req.url, key: req.headers["x-farohq-key"], body });
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "farohq-"));
  mkdirSync(join(dir, "chunks"));
  writeFileSync(join(dir, "chunks", "main-abc.js.map"), '{"version":3,"sources":[],"mappings":""}');
  const port = srv.address().port;
  const run = () =>
    new Promise((resolve, reject) => {
      execFile(process.execPath, [
        new URL("../bin/farohq-sourcemaps.mjs", import.meta.url).pathname,
        "upload", dir, "--url-prefix", "/_next/static", "--release", "abc123",
        "--endpoint", `http://127.0.0.1:${port}/api/v1`, "--delete",
      ], { env: { ...process.env, FAROHQ_KEY: "farohq_secreta" } }, (err, stdout, stderr) =>
        err ? reject(new Error(stderr || err.message)) : resolve(stdout));
    });
  const out = await run();
  srv.close();
  assert.match(out, /1 source map/);
  assert.strictEqual(got[0].key, "farohq_secreta");
  assert.ok(got[0].url.includes("release=abc123"));
  assert.ok(decodeURIComponent(got[0].url).includes("file=/_next/static/chunks/main-abc.js"));
  assert.ok(!existsSync(join(dir, "chunks", "main-abc.js.map")));
});
