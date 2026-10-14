#!/usr/bin/env node
// Envia os source maps do build para o FaroHQ (o stack do navegador volta a apontar para o código original).
//
//   FAROHQ_KEY=farohq_... npx farohq-sourcemaps upload .next/static --url-prefix /_next/static --release $GIT_SHA --delete
//
// --url-prefix: caminho onde a pasta é servida no site (Next: /_next/static; Vite: /).
// --delete: apaga os .map depois do envio, para não publicar o código-fonte no site.
// Use a chave SECRETA do projeto (FAROHQ_KEY), nunca a pública.
import { readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join, relative, sep } from "node:path";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const has = (name) => args.includes(`--${name}`);

if (args[0] !== "upload" || !args[1]) {
  console.log("Uso: farohq-sourcemaps upload <pasta> --release <sha> [--url-prefix /] [--endpoint URL] [--delete]");
  process.exit(args[0] === "--help" ? 0 : 1);
}
const dir = args[1];
const release = opt("release", process.env.GIT_SHA);
const prefix = (opt("url-prefix", "/") || "/").replace(/\/+$/, "");
const endpoint = (opt("endpoint", process.env.FAROHQ_ENDPOINT || "https://api.farohq.com.br/api/v1"))
  .replace(/\/ingest\/event\/?$/, "")
  .replace(/\/+$/, "");
const key = process.env.FAROHQ_KEY;
if (!key) {
  console.error("Defina FAROHQ_KEY (chave secreta do projeto).");
  process.exit(1);
}
if (!release) {
  console.error("Informe --release (o mesmo valor passado para o init no navegador) ou GIT_SHA.");
  process.exit(1);
}

function walk(d, out = []) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(c|m)?js\.map$/.test(name)) out.push(p);
  }
  return out;
}

const maps = walk(dir);
if (!maps.length) {
  console.error(`Nenhum .js.map em ${dir}. Ligue os source maps no build (Next: productionBrowserSourceMaps: true; Vite: build.sourcemap: true).`);
  process.exit(1);
}
let ok = 0;
let failed = 0;
for (const file of maps) {
  const rel = relative(dir, file).split(sep).join("/").replace(/\.map$/, "");
  const url = `${prefix}/${rel}`;
  const res = await fetch(`${endpoint}/ingest/sourcemaps?release=${encodeURIComponent(release)}&file=${encodeURIComponent(url)}`, {
    method: "POST",
    headers: { "X-FaroHQ-Key": key, "Content-Type": "application/json" },
    body: readFileSync(file),
  }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
  if (res.ok) {
    ok++;
    if (has("delete")) unlinkSync(file);
  } else {
    failed++;
    console.error(`✗ ${url}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
}
console.log(`FaroHQ: ${ok} source map(s) enviados para a versão ${release}${failed ? `, ${failed} com erro` : ""}.`);
process.exit(failed ? 1 : 0);
