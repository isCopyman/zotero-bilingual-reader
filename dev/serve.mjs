// Dev server for the reader front-end with a mock host. Usage: node dev/serve.mjs [port]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { build } from "esbuild";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const port = Number(process.argv[2] ?? process.env.PORT ?? 5199);
const PDF = process.env.ZBR_DEV_PDF ??
  path.join(process.env.USERPROFILE ?? "", "Zotero/storage/4LW4ETNL/Zhang et al_2021_Multi-Source and Temporal Attention Network for Probabilistic Wind Power Predict.pdf");

async function bundle(entry) {
  const r = await build({ entryPoints: [path.join(root, entry)], bundle: true, write: false, format: "iife", target: "es2022",
    define: { __env__: '"development"' }, sourcemap: "inline" });
  return r.outputFiles[0].text;
}

const routes = {
  "/": async () => [(await readFile(path.join(root, "addon/content/reader/index.html"), "utf8")).replace('<script src="reader.js"></script>', '<script src="/dev-host.js"></script><script src="/reader.js"></script>').replace('href="reader.css"', 'href="/reader.css"').replace('href="vendor/', 'href="/vendor/'), "text/html"],
  "/reader.js": async () => [await bundle("reader/main.ts"), "text/javascript"],
  "/dev-host.js": async () => [await bundle("dev/mock-host.ts"), "text/javascript"],
  "/reader.css": async () => [await readFile(path.join(root, "addon/content/reader/reader.css")), "text/css"],
  "/fixture/sdt.json": async () => [await readFile(path.join(root, "test/fixtures/zhang2021.sdt.json")), "application/json"],
  "/fixture/translations.json": async () => {
    const f = path.join(root, "dev/fixtures/translations.json");
    return existsSync(f) ? [await readFile(f), "application/json"] : ["{}", "application/json"];
  },
  "/fixture/mineru.json": async () => [await readFile(path.join(root, "test/fixtures/zhang2021.mineru.json")), "application/json"],
  "/fixture/pdf": async () => [await readFile(PDF), "application/pdf"],
  "/pdfjs/pdf.mjs": async () => [await readFile(path.join(root, "node_modules/pdfjs-dist/build/pdf.mjs")), "text/javascript"],
  "/pdfjs/pdf.worker.mjs": async () => [await readFile(path.join(root, "node_modules/pdfjs-dist/build/pdf.worker.mjs")), "text/javascript"],
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/vendor/katex/")) {
    const f = path.join(root, "node_modules/katex/dist", path.normalize(url.pathname.slice("/vendor/katex/".length)).replace(/^([.][.][\/])+/, ""));
    if (!existsSync(f)) { res.writeHead(404); return res.end(); }
    const type = f.endsWith(".css") ? "text/css" : f.endsWith(".woff2") ? "font/woff2" : "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    return res.end(await readFile(f));
  }
  const h = routes[url.pathname];
  if (!h) { res.writeHead(404); return res.end("not found"); }
  try {
    const [body, type] = await h();
    res.writeHead(200, { "content-type": type + "; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(String(e?.stack ?? e));
  }
}).listen(port, () => console.log(`ZBR dev reader on http://localhost:${port}`));
