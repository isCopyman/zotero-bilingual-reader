// Batch translation CLI.
//   node tools/zbr.mjs translate --sdt <sdt.json | .zotero-sdt-cache> --engine grok|codex|claude|openai
//        [--out cache.json] [--concurrency 4] [--limit N] [--model M] [--glossary file]
// The output is a source-hash -> Chinese map, merged incrementally, so reruns only translate what is new.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import { buildDocument } from "../core/build";
import { buildMineruDocument } from "../core/mineru-doc";
import { glossaryPrompt, parseGlossary } from "../core/translate/glossary";
import { makeBatches, PROMPT_VERSION } from "../core/translate/protocol";
import { pool, runBatch, type Engine } from "../core/translate/runner";
import { claudeEngine, codexEngine, findClaude, findCodex, findGrok, grokEngine, openaiEngine } from "./engines-node";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

async function loadSdt(file: string): Promise<any> {
  const buf = readFileSync(file);
  if (buf[0] === 0x7b) return JSON.parse(buf.toString("utf8"));
  // Binary pack: decode with Zotero's structured-document-text reader (set ZBR_SDT_READER to its src/pack/reader.js).
  const readerPath = process.env.ZBR_SDT_READER ?? path.resolve("../repo_audit/repos/zotero_reader/structured-document-text/src/pack/reader.js");
  if (!existsSync(readerPath)) throw new Error(`binary SDT pack needs ZBR_SDT_READER (not found: ${readerPath})`);
  const mod = await import(pathToFileURL(readerPath).href);
  const pack = await mod.openStructuredDocumentTextPack(new Uint8Array(buf), { inflate: (b: Uint8Array) => inflateRawSync(b) });
  return pack.materialize();
}

function makeEngine(name: string, model?: string): Engine {
  switch (name) {
    case "grok":
      if (!findGrok()) throw new Error("grok not found under ~/.grok/bin");
      return grokEngine(undefined, model);
    case "codex":
      if (!findCodex()) throw new Error("bundled codex.exe not found");
      return codexEngine(undefined, model);
    case "claude":
      if (!findClaude()) throw new Error("claude not found under ~/.local/bin");
      return claudeEngine(undefined, model);
    case "openai": {
      const base = process.env.ZBR_API_BASE ?? "https://api.openai.com/v1";
      const key = process.env.ZBR_API_KEY;
      if (!key) throw new Error("set ZBR_API_KEY (and ZBR_API_BASE, ZBR_API_MODEL)");
      return openaiEngine(base, key, model ?? process.env.ZBR_API_MODEL ?? "gpt-4o-mini", arg("effort") ?? process.env.ZBR_API_EFFORT);
    }
    default:
      throw new Error(`unknown engine ${name}`);
  }
}

async function translate() {
  const sdtFile = arg("sdt");
  if (!sdtFile) throw new Error("--sdt required");
  const out = arg("out", "translations.json")!;
  const engine = makeEngine(arg("engine", "grok")!, arg("model"));
  const concurrency = Number(arg("concurrency", "4"));
  const limit = arg("limit") ? Number(arg("limit")) : Infinity;
  const glossaryFile = arg("glossary");
  const glossary = glossaryFile ? readFileSync(glossaryFile, "utf8") : undefined;

  const doc = buildDocument(await loadSdt(sdtFile), path.basename(sdtFile));
  const cache: Record<string, string> = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
  const hashOf = new Map<string, string>();
  for (const b of doc.blocks) for (const s of b.sentences) hashOf.set(s.id, s.hash);
  const blocks = doc.blocks.filter((b) => b.translatable).slice(0, limit);
  const batches = makeBatches(blocks, (_b, id) => !cache[hashOf.get(id)!], 2600, engine.maxUnits ?? 45);
  const total = batches.reduce((n, b) => n + b.ids.length, 0);
  console.error(`${doc.title ?? sdtFile}: ${total} units in ${batches.length} batches via ${engine.label} (prompt ${PROMPT_VERSION}), concurrency ${concurrency}`);

  let done = 0;
  let failed = 0;
  const t0 = Date.now();
  await pool(batches, concurrency, async (batch, i) => {
    const t = Date.now();
    const r = await runBatch(engine, batch, { title: doc.title, glossary });
    for (const [id, zh] of Object.entries(r.ok)) cache[hashOf.get(id)!] = zh;
    done += Object.keys(r.ok).length;
    failed += r.failed.length;
    writeFileSync(out, JSON.stringify(cache, null, 1));
    console.error(`  batch ${i + 1}/${batches.length}: ${Object.keys(r.ok).length}/${batch.ids.length} ok in ${((Date.now() - t) / 1000).toFixed(1)}s` + (r.problems.length ? ` · ${r.problems.slice(0, 3).join("; ")}` : ""));
  });
  console.error(`done ${done}/${total}, failed ${failed}, ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${out}`);
}

// Pre-translate papers from their MinerU parses straight into the plugin's cache, so opening them
// in Zotero shows the translation at once (MinerU source fully; Zotero source wherever its
// sentences hash the same).
//   node tools/zbr.mjs mineru --keys keys.txt [--data ~/Zotero] [--library 1] [--papers 2]
//        [--concurrency 3] [--engine grok] [--model M] [--effort E] [--status status.json]
// keys.txt: one attachment key per line, optionally followed by a tab and a label.

interface CacheUnit {
  zh: string;
  engine: string;
  prompt: string;
  glossary: string;
  t: number;
}

interface PaperStatus {
  key: string;
  label: string;
  state: "waiting" | "running" | "done" | "skipped" | "failed";
  units?: number;
  translated?: number;
  failed?: number;
  glossaryTerms?: number;
  seconds?: number;
  note?: string;
}

function readCache(file: string, library: number, key: string): any {
  if (existsSync(file)) {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (raw?.version === 1 && raw.units) return raw;
  }
  return { version: 1, libraryID: library, attachmentKey: key, units: {} };
}

/** Merge into whatever is on disk now (the plugin may have written meanwhile), then replace atomically. */
function writeCache(file: string, library: number, key: string, units: Record<string, CacheUnit>, glossary?: string) {
  const data = readCache(file, library, key);
  for (const [h, u] of Object.entries(units)) if (!data.units[h]) data.units[h] = u;
  if (glossary && !data.glossary) data.glossary = glossary;
  const tmp = `${file}.cli.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}

async function mineru() {
  const keysFile = arg("keys");
  if (!keysFile) throw new Error("--keys required");
  const data = arg("data", path.join(homedir(), "Zotero"))!;
  const library = Number(arg("library", "1"));
  const papersAtOnce = Number(arg("papers", "2"));
  const concurrency = Number(arg("concurrency", "3"));
  const statusFile = arg("status", "mineru-status.json")!;
  const engineName = arg("engine", "grok")!;
  // grok keeps a session per call under ~/.grok/sessions/<working directory>; use the plugin's own.
  const agentHome = path.join(data, "zotero-bilingual-reader", "agent");
  mkdirSync(agentHome, { recursive: true });
  const engine = engineName === "grok" ? grokEngine(findGrok() ?? undefined, arg("model"), { cwd: agentHome, effort: arg("effort") }) : makeEngine(engineName, arg("model"));
  const engineKey = `cli:${engine.id}${arg("model") ? `|${arg("model")}` : ""}${arg("effort") ? `|${arg("effort")}` : ""}`;
  const store = path.join(data, "mineru-paper-store", "attachments");
  const cacheDir = path.join(data, "zotero-bilingual-reader", "translations");
  mkdirSync(cacheDir, { recursive: true });

  const papers: PaperStatus[] = readFileSync(keysFile, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [key, ...rest] = l.split("\t");
      return { key: key.trim(), label: rest.join(" ").trim(), state: "waiting" as const };
    });
  const saveStatus = () => writeFileSync(statusFile, JSON.stringify({ updated: new Date().toISOString(), engine: engineKey, papers }, null, 1));
  saveStatus();
  console.error(`${papers.length} papers via ${engine.label}, ${papersAtOnce} at a time, ${concurrency} requests each`);

  await pool(papers, papersAtOnce, async (paper) => {
    const t0 = Date.now();
    const tag = `[${paper.key}]`;
    try {
      const dir = path.join(store, paper.key);
      const parse = existsSync(path.join(dir, "parse.json")) ? JSON.parse(readFileSync(path.join(dir, "parse.json"), "utf8")) : null;
      const listFile = path.join(dir, "raw", "content_list.json");
      if (parse?.status !== "complete" || !existsSync(listFile)) {
        Object.assign(paper, { state: "skipped", note: "no complete MinerU parse" });
        return;
      }
      paper.state = "running";
      saveStatus();
      const doc = buildMineruDocument(JSON.parse(readFileSync(listFile, "utf8")), { pages: [], pdfHash: "", title: paper.label } as any, paper.key);
      const file = path.join(cacheDir, `${library}-${paper.key}.json`);
      const cached = readCache(file, library, paper.key);

      // Paper glossary first, as the plugin does, so all batches use the same terms.
      // A failed or empty answer is not stored, so the next run asks again.
      let glossary: string = cached.glossary ?? "";
      if (!glossary) {
        try {
          glossary = parseGlossary(await engine.complete(glossaryPrompt(doc)));
        } catch (e: any) {
          console.error(`${tag} glossary failed: ${e?.message ?? e}`);
        }
        if (glossary) writeCache(file, library, paper.key, {}, glossary);
        else console.error(`${tag} glossary: no terms`);
      }
      paper.glossaryTerms = glossary ? glossary.split("\n").length : 0;
      const g = glossary.trim() ? createHash("md5").update(glossary.trim(), "utf8").digest("hex").slice(0, 8) : "";

      const hashOf = new Map<string, string>();
      for (const b of doc.blocks) for (const s of b.sentences) hashOf.set(s.id, s.hash);
      const todo = (_b: unknown, id: string) => !cached.units[hashOf.get(id)!];
      const blocks = doc.blocks.filter((b) => b.translatable);
      const batches = makeBatches(blocks, todo, 2600, engine.maxUnits ?? 45);
      paper.units = batches.reduce((n, b) => n + b.ids.length, 0);
      paper.translated = 0;
      paper.failed = 0;
      saveStatus();
      console.error(`${tag} ${paper.label || doc.title}: ${paper.units} sentences in ${batches.length} batches, glossary ${paper.glossaryTerms} terms`);
      await pool(batches, concurrency, async (batch) => {
        let r;
        try {
          r = await runBatch(engine, batch, { title: doc.title, glossary });
        } catch (e: any) {
          paper.failed! += batch.ids.length;
          console.error(`${tag} batch failed: ${e?.message ?? e}`);
          saveStatus();
          return;
        }
        const units: Record<string, CacheUnit> = {};
        for (const [id, zh] of Object.entries(r.ok)) units[hashOf.get(id)!] = { zh, engine: engineKey, prompt: PROMPT_VERSION, glossary: g, t: Date.now() };
        writeCache(file, library, paper.key, units);
        if (r.failed.length) console.error(`${tag} ${r.failed.length} failed: ${r.problems.slice(-3).join("; ")}`);
        paper.translated! += Object.keys(r.ok).length;
        paper.failed! += r.failed.length;
        saveStatus();
      });
      paper.state = "done";
    } catch (e: any) {
      Object.assign(paper, { state: "failed", note: String(e?.message ?? e).slice(0, 300) });
    } finally {
      paper.seconds = Math.round((Date.now() - t0) / 1000);
      saveStatus();
      console.error(`${tag} ${paper.state} ${paper.translated ?? 0}/${paper.units ?? 0} (${paper.failed ?? 0} failed) in ${paper.seconds}s${paper.note ? ` · ${paper.note}` : ""}`);
    }
  });
  const done = papers.filter((p) => p.state === "done").length;
  console.error(`finished: ${done}/${papers.length} papers done -> ${statusFile}`);
}

// Engine benchmark: the same sentences of one MinerU paper through each engine in turn, with the
// paper's cached glossary. Records time, requests, failures and check problems per engine, and the
// translations for a blind quality rating. Nothing is written to the translation cache.
//   node tools/zbr.mjs bench --key KEY --engines "api:k3-256k:low,grok::medium" [--limit 120]
//        [--concurrency 8] [--out dev/out/bench]
// Engine spec: api:<model>[:<effort>] (ZBR_API_BASE/ZBR_API_KEY) or grok|codex|claude:[model][:effort].
async function bench() {
  const key = arg("key");
  if (!key) throw new Error("--key required");
  const data = arg("data", path.join(homedir(), "Zotero"))!;
  const limit = Number(arg("limit", "120"));
  const concurrency = Number(arg("concurrency", "8"));
  const outDir = arg("out", "dev/out/bench")!;
  mkdirSync(outDir, { recursive: true });
  const dir = path.join(data, "mineru-paper-store", "attachments", key);
  const doc = buildMineruDocument(JSON.parse(readFileSync(path.join(dir, "raw", "content_list.json"), "utf8")), { pages: [], pdfHash: "", title: "" } as any, key);
  const cached = readCache(path.join(data, "zotero-bilingual-reader", "translations", `1-${key}.json`), 1, key);
  const glossary = cached.glossary ?? "";
  // The first translatable paragraphs up to the limit: same sentences for every engine.
  const picked = new Set<string>();
  const en = new Map<string, string>();
  for (const b of doc.blocks) {
    if (!b.translatable || picked.size >= limit) continue;
    for (const s of b.sentences) {
      picked.add(s.id);
      en.set(s.id, s.text);
    }
  }
  const blocks = doc.blocks.filter((b) => b.translatable && b.sentences.some((s) => picked.has(s.id)));
  const agentHome = path.join(data, "zotero-bilingual-reader", "agent");
  const specs = (arg("engines") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const rows: string[] = ["engine,sentences,seconds,sentences_per_min,requests,failed,problems"];
  for (const spec of specs) {
    const [kind, model = "", effort = ""] = spec.split(":");
    let engine: Engine;
    if (kind === "api") {
      if (!process.env.ZBR_API_KEY) throw new Error("set ZBR_API_KEY");
      engine = openaiEngine(process.env.ZBR_API_BASE ?? "https://api.openai.com/v1", process.env.ZBR_API_KEY, model, effort || undefined);
    } else if (kind === "grok") engine = grokEngine(findGrok() ?? undefined, model || undefined, { cwd: agentHome, effort: effort || undefined });
    else if (kind === "codex") engine = codexEngine(undefined, model || undefined, effort || undefined);
    else if (kind === "claude") engine = claudeEngine(undefined, model || undefined, effort || undefined);
    else engine = makeEngine(kind, model || undefined);
    let requests = 0;
    const counted: Engine = { ...engine, complete: (p, signal) => (requests++, engine.complete(p, signal)) };
    const batches = makeBatches(blocks, (_b: unknown, id: string) => picked.has(id), 2600, engine.maxUnits ?? 45);
    const ok: Record<string, string> = {};
    const failed: string[] = [];
    const problems: string[] = [];
    const t0 = Date.now();
    await pool(batches, concurrency, async (batch) => {
      try {
        const r = await runBatch(counted, batch, { title: doc.title, glossary });
        Object.assign(ok, r.ok);
        failed.push(...r.failed);
        problems.push(...r.problems);
      } catch (e: any) {
        failed.push(...batch.ids);
        problems.push(String(e?.message ?? e).slice(0, 200));
      }
    });
    const seconds = (Date.now() - t0) / 1000;
    const label = spec.replace(/[:]/g, "_");
    writeFileSync(path.join(outDir, `${label}.json`), JSON.stringify({ spec, key, seconds, requests, failed, problems, translations: Object.fromEntries([...picked].map((id) => [id, { en: en.get(id), zh: ok[id] ?? null }])) }, null, 1));
    const row = [spec, picked.size, seconds.toFixed(0), ((Object.keys(ok).length / seconds) * 60).toFixed(0), requests, failed.length, problems.length].join(",");
    rows.push(row);
    console.error(row);
  }
  writeFileSync(path.join(outDir, "summary.csv"), rows.join("\n") + "\n");
}

const cmd = process.argv[2];
const commands: Record<string, () => Promise<void>> = { translate, mineru, bench };
(commands[cmd] ? commands[cmd]() : Promise.reject(new Error("usage: zbr translate --sdt <file> ... | zbr mineru --keys <file> ..."))).catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
