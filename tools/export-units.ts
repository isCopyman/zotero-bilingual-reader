// Export a paper as a whole-paper agent task: units.json (sections -> paragraphs -> numbered
// sentences) and TASK.md, as the plugin writes them.
// Usage: node tools/export-units.mjs <sdt.json> <out-dir> [mineru content_list.json]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildDocument } from "../core/build";
import { buildMineruDocument } from "../core/mineru-doc";
import { buildUnitsFile, taskText } from "../core/translate/whole";

const [sdtPath, outDir, mineruPath] = process.argv.slice(2);
const base = buildDocument(JSON.parse(readFileSync(sdtPath, "utf8")), "");
const doc = mineruPath ? buildMineruDocument(JSON.parse(readFileSync(mineruPath, "utf8")), base) : base;

const todo = new Set(doc.blocks.filter((b) => b.translatable).flatMap((b) => b.sentences.map((s) => s.id)));
const units = buildUnitsFile(doc, todo, () => undefined);
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "units.json"), JSON.stringify(units, null, 1));
writeFileSync(path.join(outDir, "TASK.md"), taskText({ dir: path.resolve(outDir), title: doc.title, todo: todo.size, partial: false, math: doc.parser.kind === "mineru" }));
console.log(`${units.sections.length} sections, ${todo.size} units -> ${outDir}`);
