// Dev-only host: serves the fixture document and simulates translation.
import { buildDocument } from "../core/build";
import { DEFAULT_PREFS, type HostEvent, type ReaderPrefs, type UnitTranslation, type ZbrHost } from "../core/host-api";
import { matchMineru, type Enrichment } from "../core/mineru";
import type { ZbrDocument } from "../core/model";

const listeners = new Set<(ev: HostEvent) => void>();
const emit = (ev: HostEvent) => listeners.forEach((l) => l(ev));
let doc: ZbrDocument;
let tr: Record<string, UnitTranslation> = {};
let fixtureTr: Record<string, string> = {};
let cancelled = false;
let running = false;
const queue: string[] = [];

async function pump() {
  if (running) return;
  running = true;
  cancelled = false;
  emit({ type: "progress", progress: { running: true, done: 0, total: 0, failed: 0, engineLabel: "mock" } });
  while (queue.length && !cancelled) {
    const bid = queue.shift()!;
    const b = doc.blocks.find((x) => x.id === bid);
    if (!b) continue;
    await new Promise((r) => setTimeout(r, 120));
    const units: Record<string, UnitTranslation> = {};
    for (const s of b.sentences) {
      if (tr[s.id]?.srcHash === s.hash) continue;
      units[s.id] = { zh: fixtureTr[s.hash] ?? `【模拟译文】${s.text.slice(0, 60)}`, srcHash: s.hash };
    }
    Object.assign(tr, units);
    emit({ type: "translations", units });
  }
  running = false;
  emit({ type: "progress", progress: { running: false, done: 0, total: 0, failed: 0, engineLabel: "mock" } });
}

let docReady: Promise<ZbrDocument> | undefined;
async function loadDoc(): Promise<ZbrDocument> {
  const sdt = await (await fetch("/fixture/sdt.json")).json();
  doc = buildDocument(sdt, "DEV");
  try {
    fixtureTr = await (await fetch("/fixture/translations.json")).json();
  } catch {
    fixtureTr = {};
  }
  if (new URLSearchParams(location.search).has("pretranslated")) {
    for (const b of doc.blocks) for (const s of b.sentences) if (fixtureTr[s.hash]) tr[s.id] = { zh: fixtureTr[s.hash], srcHash: s.hash };
  }
  return doc;
}

const host: ZbrHost = {
  capabilities: { openInPdf: false, highlights: false },
  pdfjs: { lib: "/pdfjs/pdf.mjs", worker: "/pdfjs/pdf.worker.mjs" },
  getDocument() {
    docReady ??= loadDoc();
    return docReady;
  },
  async getEnrichment() {
    const d = await (docReady ??= loadDoc());
    if (new URLSearchParams(location.search).has("nomineru")) return null;
    const items = await (await fetch("/fixture/mineru.json")).json();
    return matchMineru(d, items) as Record<string, Enrichment>;
  },
  async getTranslations() {
    await (docReady ??= loadDoc());
    return { ...tr };
  },
  subscribe(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  async translate(req) {
    const ids = req.all ? doc.blocks.filter((b) => b.translatable).map((b) => b.id) : req.blockIds ?? [];
    for (const id of ids) if (!queue.includes(id)) queue.push(id);
    pump();
  },
  async cancel() {
    cancelled = true;
    queue.length = 0;
  },
  async editTranslation(id: string, zh: string) {
    const s = doc.blocks.flatMap((b) => b.sentences).find((x) => x.id === id)!;
    tr[id] = { zh, srcHash: s.hash };
    emit({ type: "translations", units: { [id]: tr[id] } });
  },
  async clearTranslations() {
    for (const k of Object.keys(tr)) delete tr[k];
  },
  async getPaperGlossary() {
    return localStorage.getItem("zbr-glossary");
  },
  async setPaperGlossary(t: string) {
    localStorage.setItem("zbr-glossary", t);
  },
  async startHandoff() {
    throw new Error("模拟环境不支持交给 Agent");
  },
  async getHandoff() {
    return null;
  },
  async handoffFix() {
    return null;
  },
  async stopHandoff() {},
  async openHandoffFile() {},
  async getEngines() {
    return [{ id: "mock", label: "模拟引擎", kind: "mock", ready: true }];
  },
  async getPdfData() {
    return new Uint8Array(await (await fetch("/fixture/pdf")).arrayBuffer());
  },
  async openInPdf() {},
  async getHighlights() {
    return [];
  },
  async createHighlight() {},
  async updateHighlight() {},
  async deleteHighlight() {},
  async openHighlight() {},
  async hasMineru() {
    return false;
  },
  async getPosition() {
    return localStorage.getItem("zbr-pos");
  },
  async setPosition(b: string) {
    localStorage.setItem("zbr-pos", b);
  },
  async getPrefs() {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem("zbr-prefs") ?? "{}") } as ReaderPrefs;
  },
  async setPrefs(p) {
    const cur = JSON.parse(localStorage.getItem("zbr-prefs") ?? "{}");
    localStorage.setItem("zbr-prefs", JSON.stringify({ ...cur, ...p }));
  },
};
window.zbrHost = host;
window.dispatchEvent(new Event("zbr-host-ready"));
