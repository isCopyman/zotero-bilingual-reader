// Copies third-party assets the reader page loads at runtime (KaTeX CSS + fonts) into the addon.
import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dest = path.join(root, "addon/content/reader/vendor/katex");
mkdirSync(dest, { recursive: true });
const src = path.join(root, "node_modules/katex/dist");
cpSync(path.join(src, "katex.min.css"), path.join(dest, "katex.min.css"));
cpSync(path.join(src, "fonts"), path.join(dest, "fonts"), { recursive: true, filter: (f) => !/\.(ttf|woff)$/.test(f) });
console.log("vendor assets ->", path.relative(root, dest));
