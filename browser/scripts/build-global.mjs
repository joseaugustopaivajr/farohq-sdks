// Gera dist/farohq.global.js para usar com <script> (sem bundler): window.FaroHQ.init({...})
import { readFileSync, writeFileSync } from "node:fs";

const esm = readFileSync(new URL("../dist/index.js", import.meta.url), "utf8");
const names = [];
let body = esm
  .replace(/^export default \{[^}]*\};?\s*$/m, "")
  .replace(/^export (function|const|let|class) (\w+)/gm, (_, kind, name) => {
    names.push(name);
    return `${kind} ${name}`;
  });
const out = `/*! @farohq/browser — MIT */\n(function () {\n${body}\nwindow.FaroHQ = { ${names.join(", ")} };\n})();\n`;
writeFileSync(new URL("../dist/farohq.global.js", import.meta.url), out);
console.log("dist/farohq.global.js:", names.join(", "));
