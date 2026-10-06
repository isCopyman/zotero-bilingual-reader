// Translation protocol: the model sees whole paragraphs for context but must return exactly one
// Chinese rendering per requested English source sentence id. The program owns ids and anchors.

import type { Block } from "../model";
import { INLINE_MATH } from "../segment";

export const PROMPT_VERSION = "p4";

export interface BatchUnit {
  id: string;
  en: string;
}

export interface BatchParagraph {
  blockId: string;
  kind: string;
  /** Sentences to translate (a subset of the paragraph when some are cached or being retried). */
  units: BatchUnit[];
  /** The whole paragraph, sent as context whenever only part of it is requested. */
  fullText: string;
  totalUnits: number;
  /** Units carry inline LaTeX as `$…$` that must survive translation. */
  math?: boolean;
}

export interface Batch {
  paragraphs: BatchParagraph[];
  ids: string[];
  chars: number;
}

export interface PromptOptions {
  title?: string;
  glossary?: string;
  targetLang?: string;
}

/**
 * Pack requested sentences into batches without splitting a paragraph across batches.
 * The character and unit budgets are soft: a single paragraph larger than the budget still
 * forms one batch.
 */
export function makeBatches(blocks: Block[], unitFilter: (blockId: string, unitId: string) => boolean, maxChars = 2600, maxUnits = 45): Batch[] {
  const batches: Batch[] = [];
  let cur: Batch = { paragraphs: [], ids: [], chars: 0 };
  const flush = () => {
    if (cur.ids.length) batches.push(cur);
    cur = { paragraphs: [], ids: [], chars: 0 };
  };
  for (const b of blocks) {
    if (!b.translatable) continue;
    const units = b.sentences.filter((s) => unitFilter(b.id, s.id)).map((s) => ({ id: s.id, en: s.text }));
    if (!units.length) continue;
    const chars = units.reduce((n, u) => n + u.en.length, 0);
    if (cur.ids.length && (cur.chars + chars > maxChars || cur.ids.length + units.length > maxUnits)) flush();
    cur.paragraphs.push({ blockId: b.id, kind: b.kind, units, fullText: b.text, totalUnits: b.sentences.length, ...(b.inlineMath ? { math: true } : {}) });
    cur.ids.push(...units.map((u) => u.id));
    cur.chars += chars;
  }
  flush();
  return batches;
}

/** Keep only the given ids; paragraphs keep their full text so the model still sees context. */
export function subBatch(batch: Batch, ids: Set<string>): Batch {
  const paragraphs = batch.paragraphs
    .map((p) => ({ ...p, units: p.units.filter((u) => ids.has(u.id)) }))
    .filter((p) => p.units.length);
  const all = paragraphs.flatMap((p) => p.units);
  return { paragraphs, ids: all.map((u) => u.id), chars: all.reduce((n, u) => n + u.en.length, 0) };
}

export function systemPrompt(opts: PromptOptions): string {
  const lang = opts.targetLang ?? "简体中文";
  return [
    `You are an expert translator of scientific papers into ${lang}.`,
    `Write as a native ${lang} academic author of the paper's own field would, following the conventions of ${lang} journals in that field, so that readers do not notice it is a translation.`,
    "Stay faithful: add or drop no information; keep hedging, negation and caveats exactly.",
    "Rules:",
    "1. Input is a list of paragraphs; each has sentence units with ids. A paragraph may also carry \"context\" (its full original text): use it to understand the units, but never translate or output it.",
    "2. Output EXACTLY one translation per unit id, in the same order. Never merge two ids, never split one id into two items, never skip or invent ids.",
    "3. A long English sentence may become several Chinese sentences, but they all stay in that id's \"zh\" string.",
    "4. Keep citation markers ([12], [3]-[5], (Zhang et al., 2021)), equation/figure/table references, numbers, units, variable names, model names and acronyms unchanged.",
    "5. Headings: translate concisely; keep numbering such as \"II.\" or \"3.1\".",
    "5b. Inline LaTeX between dollar signs ($x_t$, $[1]$) is copied into the translation unchanged, dollar signs included.",
    "6. Output only JSON: {\"translations\":[{\"id\":\"...\",\"zh\":\"...\"}]} with no commentary or code fences.",
    opts.glossary?.trim() ? `Glossary (English = ${lang}), use consistently:\n${opts.glossary.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function userPrompt(batch: Batch, opts: PromptOptions): string {
  const payload = {
    paper: opts.title ?? "",
    paragraphs: batch.paragraphs.map((p) => ({
      type: p.kind,
      ...(p.units.length < p.totalUnits ? { context: p.fullText } : {}),
      units: p.units,
    })),
  };
  return `Translate these units. Return {"translations":[...]} with ${batch.ids.length} items.\n${JSON.stringify(payload)}`;
}

/** Single text prompt for CLI agents that take one message. */
export function combinedPrompt(batch: Batch, opts: PromptOptions): string {
  return `${systemPrompt(opts)}\n\nDo not use any tools; answer directly.\n\n${userPrompt(batch, opts)}`;
}

export interface ParseResult {
  ok: Record<string, string>;
  missing: string[];
  problems: string[];
}

function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  // Find the outermost {...} or [...] that parses.
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const a = t.indexOf(open);
    const b = t.lastIndexOf(close);
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1));
      } catch {
        /* next */
      }
    }
  }
  return null;
}

const CJK = /[㐀-鿿]/;
const CITATION = /\[\d+(?:\s*[-–]\s*\d+)?(?:\s*,\s*\d+(?:\s*[-–]\s*\d+)?)*\]/g;

/** Numbers inside numeric citation markers, e.g. "[3]-[5], [12]" -> 3,5,12. */
export function citationNumbers(text: string): string[] {
  const out: string[] = [];
  // Reference numbers never start with 0: "[01]" is an interval like [0,1] that lost its comma.
  for (const m of text.replace(/［/g, "[").replace(/］/g, "]").matchAll(CITATION)) out.push(...(m[0].match(/\d+/g) ?? []).filter((n) => !n.startsWith("0")));
  return out;
}

/** Citation numbers present in the source but absent from the translation. */
/** Inline formulas of the source missing from the translation (compared without spaces). */
export function lostMath(en: string, zh: string): string[] {
  const norm = (s: string) => s.replace(/\s+/g, "");
  const have = new Set([...zh.matchAll(INLINE_MATH)].map((m) => norm(m[1])));
  return [...en.matchAll(INLINE_MATH)].map((m) => m[0]).filter((m) => !have.has(norm(m.slice(1, -1))));
}

export function lostCitations(en: string, zh: string): string[] {
  const have = new Set(citationNumbers(zh));
  return [...new Set(citationNumbers(en))].filter((n) => !have.has(n));
}

/**
 * Why a translation of one source sentence is unusable, or null. `math`: the source marks inline
 * formulas with `$…$` (MinerU text); elsewhere a dollar sign is just a dollar sign.
 */
/** "A. Name $^{a}$ , B. Name $^{b,*}$ ..." — an author line, rightly left in English. */
function isNameList(en: string): boolean {
  // Footnote marks, escaped asterisks and ORCID "iD" badges sit between the names.
  const plain = en.replace(/\$[^$]*\$/g, " ").replace(/[\\*†‡§¶#]|\d+|\biD\b/g, " ");
  const parts = plain.split(/,|;|\band\b/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  // Each part: one to five capitalised name words (a missing comma joins two names).
  return parts.every((p) => /^([A-Z][\p{L}'’.-]*\.?\s*){1,5}$/u.test(p));
}

export function checkUnit(en: string, zh: string, math = false): string | null {
  if (!zh.trim()) return "empty translation";
  // Untranslated output for a real sentence (symbol-only or very short units may stay as they are).
  // A sentence has several plain words; formula text like "ξwind,i t ∈ Rdmodel" does not.
  const words = en.split(/\s+/).filter((w) => /^[A-Za-z][a-z]+[,.;:]?$/.test(w)).length;
  if (!CJK.test(zh) && words >= 4 && en.length > 25 && !isNameList(en)) return "not translated";
  const lost = lostCitations(en, zh);
  if (lost.length) return `lost citation [${lost.join(",")}]`;
  const formulas = math ? lostMath(en, zh) : [];
  if (formulas.length) return `lost inline math ${formulas.join(" ")}`;
  return null;
}

export function parseResponse(text: string, batch: Batch): ParseResult {
  const problems: string[] = [];
  const data = extractJson(text) as any;
  const items: any[] = Array.isArray(data) ? data : Array.isArray(data?.translations) ? data.translations : [];
  if (!items.length) problems.push("no JSON translations found");
  const expected = new Map<string, string>();
  const mathIds = new Set<string>();
  for (const p of batch.paragraphs)
    for (const u of p.units) {
      expected.set(u.id, u.en);
      if (p.math) mathIds.add(u.id);
    }
  const ok: Record<string, string> = {};
  const seen = new Set<string>();
  for (const it of items) {
    const id = typeof it?.id === "string" ? it.id : String(it?.id ?? "");
    const zh = typeof it?.zh === "string" ? it.zh.trim() : "";
    if (!expected.has(id)) {
      problems.push(`unexpected id ${id}`);
      continue;
    }
    if (seen.has(id)) {
      problems.push(`duplicate id ${id}`);
      delete ok[id];
      continue;
    }
    seen.add(id);
    const problem = checkUnit(expected.get(id)!, zh, mathIds.has(id));
    if (problem) {
      problems.push(`${problem} in ${id}`);
      continue;
    }
    ok[id] = zh;
  }
  const missing = [...expected.keys()].filter((id) => !(id in ok));
  return { ok, missing, problems };
}
