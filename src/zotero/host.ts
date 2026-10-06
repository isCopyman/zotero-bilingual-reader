// ZbrHost implementation backed by Zotero: SDT document, translation scheduler, cache, MinerU.

import { buildDocument } from "../../core/build";
import { DEFAULT_PREFS, type DocSource, type HandoffInfo, type HighlightView, type HostEvent, type ReaderPrefs, type TranslationProgress, type UnitTranslation, type ZbrHost } from "../../core/host-api";
import { Locator, type PagePosition } from "../../core/locate";
import { matchMineru, type Enrichment } from "../../core/mineru";
import { buildMineruDocument, type MineruContentItem } from "../../core/mineru-doc";
import type { Block, ZbrDocument } from "../../core/model";
import { mergeLineRects } from "../../core/textmap";
import { makeBatches, type Batch } from "../../core/translate/protocol";
import { runBatch, type Engine } from "../../core/translate/runner";
import { glossaryPrompt, mergeGlossaries, parseGlossary } from "../../core/translate/glossary";
import { buildUnitsFile, collect, expectedUnits, FIX_FILE, FIX_RESULT_FILE, fixPrompt, fixText, handoffPhase, PARTS_DIR, RESULT_FILE, startCommands, startPrompt, taskText, type Collected, type Expected, type FixItem } from "../../core/translate/whole";
import { cleanupAgentSessions, engineConcurrency, engineConfigKey, getEngine, listEngines } from "./engines";
import { getPref, setPref } from "./prefs";
import { alignDocuments, type Alignment } from "../../core/align";
import { parseOnMineruCloud } from "./mineru-cloud";
import { TranslationStore } from "./store";
import { clearTimeout, newAbortController, setTimeout, subtleCrypto } from "./globals";

export interface ZoteroHost extends ZbrHost {
  dispose(): void;
  /** Current translation progress, without waiting for an event. */
  getProgressSnapshot(): TranslationProgress;
}

async function loadDocument(attachment: any, onProgress: (pct: number) => void): Promise<{ doc: ZbrDocument; locator: Locator }> {
  // First open of a PDF makes Zotero generate its structured text, which can take a while.
  const SDT_TIMEOUT = 180_000;
  let timer: number | undefined;
  const reader = await Promise.race([
    (Zotero as any).SDT.getReader(attachment.id, { isPriority: true, onProgress }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Zotero 解析这篇 PDF 超过 3 分钟仍未完成，请稍后重新打开。")), SDT_TIMEOUT);
    }),
  ]).finally(() => clearTimeout(timer));
  if (!reader) throw new Error("Zotero 暂时无法提供这篇 PDF 的结构化文本（阅读模式数据）。请确认 PDF 可以在 Zotero 中正常打开，稍后重试。");
  const sdt = await reader.materialize();
  const doc = buildDocument(sdt, attachment.key);
  return { doc, locator: new Locator(sdt, doc) };
}

function readPrefs(): ReaderPrefs {
  try {
    const raw = String(getPref("readerPrefs") || "");
    const saved = raw ? JSON.parse(raw) : {};
    // Before v2 every save wrote the old default autoTranslate=true, so it says nothing about a choice.
    if (!saved.v) delete saved.autoTranslate;
    return { ...DEFAULT_PREFS, ...saved };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = subtleCrypto();
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}


interface Job {
  batch: Batch;
  gen: number;
}

/** How often an open paper checks its cache file for translations written by others. */
const CACHE_CHECK_MS = 5000;

export interface HostOptions {
  /** Fixed text source (background pre-translation); otherwise the reader's chosen source. */
  source?: DocSource;
}

export function createHost(attachment: any, opts: HostOptions = {}): ZoteroHost {
  const listeners = new Set<(ev: HostEvent) => void>();
  /** What the page was last given per sentence (unit id -> Chinese), so cache changes send only differences. */
  const shown = new Map<string, string>();
  const emit = (ev: HostEvent) => {
    if (ev.type === "translations") for (const [id, u] of Object.entries(ev.units)) shown.set(id, u.zh);
    for (const l of listeners) {
      try {
        l(ev);
      } catch (e) {
        Zotero.logError(e as Error);
      }
    }
  };

  const progress: TranslationProgress = { running: false, done: 0, total: 0, failed: 0 };
  const ready = (async () => {
    const onProgress = (pct: number) => emit({ type: "progress", progress: { ...progress, message: `Zotero 正在解析 PDF ${Math.round(pct)}%` } });
    const [{ doc, locator }, store] = await Promise.all([loadDocument(attachment, onProgress), TranslationStore.open(attachment.libraryID, attachment.key)]);
    return { doc, locator, store, blocks: new Map(doc.blocks.map((b) => [b.id, b])) };
  })();
  let pdfBytes: Promise<Uint8Array> | null = null;
  const getPdfData = () => (pdfBytes ??= (async () => IOUtils.read(await attachment.getFilePathAsync()))());

  // MinerU parse of this exact PDF, if there is one (the user's own MinerU, or a cloud parse the
  // reader asked for, both in the same store layout).
  let mineruItems: Promise<MineruContentItem[] | null> | null = null;
  const mineruDir = () =>
    PathUtils.join(String(getPref("mineruRoot") || "").trim() || PathUtils.join(Zotero.DataDirectory.dir, "mineru-paper-store"), "attachments", attachment.key);
  const loadMineru = () =>
    (mineruItems ??= (async () => {
      const dir = mineruDir();
      const parsePath = PathUtils.join(dir, "parse.json");
      const listPath = PathUtils.join(dir, "raw", "content_list.json");
      if (!(await IOUtils.exists(parsePath)) || !(await IOUtils.exists(listPath))) return null;
      const parse: any = await IOUtils.readJSON(parsePath);
      if (parse?.status && parse.status !== "complete") return null;
      // Only a parse that provably belongs to this exact file may be shown or pasted in.
      if (!parse?.pdfSha256 || parse.pdfSha256 !== (await sha256Hex(await getPdfData()))) return null;
      return (await IOUtils.readJSON(listPath)) as MineruContentItem[];
    })().catch((e) => {
      Zotero.logError(e);
      return null;
    }));

  // The document shown follows the "source" preference; blocks of both documents share one map
  // (ids differ: SDT paths vs "m…"), so the scheduler serves whichever is on screen.
  let mineruDoc: Promise<ZbrDocument | null> | null = null;
  const loadMineruDoc = async () => {
    const { doc, blocks } = await ready;
    mineruDoc ??= loadMineru().then((items) => {
      if (!items) return null;
      const m = buildMineruDocument(items, doc, attachment.key);
      for (const b of m.blocks) blocks.set(b.id, b);
      return m;
    });
    return mineruDoc;
  };
  const usingMineru = () => (opts.source ?? readPrefs().source) === "mineru";
  async function activeDoc(): Promise<ZbrDocument> {
    const { doc } = await ready;
    if (!usingMineru()) return doc;
    return (await loadMineruDoc()) ?? doc;
  }
  // MinerU sentences mapped onto the Zotero text, which alone carries PDF geometry.
  let alignment: Promise<Alignment | null> | null = null;
  const getAlignment = () =>
    (alignment ??= (async () => {
      const m = await loadMineruDoc();
      return m ? alignDocuments((await ready).doc, m) : null;
    })().catch((e) => {
      Zotero.logError(e);
      return null;
    }));
  /** Pieces of SDT text behind a sentence of either source (a MinerU one via the alignment). */
  async function sdtPieces(unitIds: string[]): Promise<{ block: Block; start: number; end: number }[]> {
    const { blocks } = await ready;
    const out: { block: Block; start: number; end: number }[] = [];
    for (const id of unitIds) {
      const block = blocks.get(id.slice(0, id.lastIndexOf(":")));
      const s = block?.sentences.find((x) => x.id === id);
      if (!block || !s) continue;
      if (!block.id.startsWith("m")) {
        out.push({ block, start: s.start, end: s.end });
        continue;
      }
      for (const p of (await getAlignment())?.toSdt.get(id) ?? []) {
        const b = blocks.get(p.blockId);
        if (b) out.push({ block: b, start: p.start, end: p.end });
      }
    }
    return out;
  }

  // Scheduler. Blocks wait in `queue`; pump() turns them into jobs and starts at most
  // `concurrency` jobs. Units are tracked individually so overlapping requests (viewport
  // prefetch, full-text, retries) never translate the same sentence twice at once.
  const queue: string[] = [];
  const queued = new Set<string>();
  const jobs: Job[] = [];
  const inFlight = new Set<string>();
  const failedUnits = new Set<string>();
  /** Units the user asked to translate again even though a cached translation exists. */
  const forceUnits = new Set<string>();
  let running = 0;
  // Bumped by cancel(): work started under an older generation must not touch shared state.
  let generation = 0;
  let controller = newAbortController();
  let engineCache: { key: string; engine: Engine; concurrency: number } | null = null;
  let disposed = false;
  let lastMessage: string | undefined;

  const emitProgress = (message?: string) => {
    if (message !== undefined) lastMessage = message;
    progress.running = running > 0 || jobs.length > 0 || queue.length > 0;
    progress.message = lastMessage;
    emit({ type: "progress", progress: { ...progress } });
  };

  const needs = (s: { id: string; hash: string }, store: TranslationStore) =>
    !inFlight.has(s.id) && !failedUnits.has(s.id) && (forceUnits.has(s.id) || !store.get(s.hash));

  async function engineFor(): Promise<{ engine: Engine; concurrency: number }> {
    const id = readPrefs().engineId || "agent:grok";
    const key = engineConfigKey(id);
    if (engineCache?.key !== key) engineCache = { key, ...(await getEngine(id)) };
    engineCache.concurrency = engineConcurrency(id);
    return engineCache;
  }

  const glossary = () => String(getPref("glossary") || "");

  async function pump() {
    const gen = generation;
    if (disposed) return;
    const { doc, store, blocks } = await ready;
    let eng: { engine: Engine; concurrency: number };
    try {
      eng = await engineFor();
    } catch (e: any) {
      if (gen !== generation) return;
      queue.length = 0;
      queued.clear();
      emitProgress(e?.message ?? String(e));
      return;
    }
    if (gen !== generation || disposed) return;
    progress.engineLabel = eng.engine.label;
    if (queue.length) ensurePaperGlossary(eng.engine, doc, store);
    const budget = Number(getPref("batchChars") || 2600);
    while (running < eng.concurrency) {
      if (!jobs.length) {
        // Take whole paragraphs up to the character budget; the model sees each one intact.
        const take: Block[] = [];
        let chars = 0;
        while (queue.length && (chars < budget || !take.length)) {
          const b = blocks.get(queue.shift()!)!;
          queued.delete(b.id);
          const units = b.sentences.filter((s) => needs(s, store));
          if (!units.length) continue;
          take.push(b);
          chars += units.reduce((n, s) => n + s.text.length, 0);
        }
        if (!take.length) break;
        const wanted = new Set(take.flatMap((b) => b.sentences.filter((s) => needs(s, store)).map((s) => s.id)));
        for (const batch of makeBatches(take, (_b, id) => wanted.has(id), budget, 45)) {
          for (const id of batch.ids) inFlight.add(id);
          jobs.push({ batch, gen });
        }
      }
      const job = jobs.shift()!;
      running++;
      void runJob(eng.engine, job, doc, store, blocks);
    }
    emitProgress();
  }

  async function runJob(engine: Engine, job: Job, doc: ZbrDocument, store: TranslationStore, blocks: Map<string, Block>) {
    const { batch, gen } = job;
    const signal = controller.signal;
    const hashOf = new Map<string, string>();
    for (const p of batch.paragraphs) for (const s of blocks.get(p.blockId)!.sentences) hashOf.set(s.id, s.hash);
    let message: string | undefined;
    // What the model is asked with is fixed when the job starts; the cache records exactly that.
    const config = engineCache?.key ?? engine.id;
    const gl = mergeGlossaries(glossary(), store.glossary ?? "");
    try {
      const r = await runBatch(engine, batch, { title: doc.title, glossary: gl }, 2, signal);
      if (gen !== generation || disposed) return;
      const units: Record<string, UnitTranslation> = {};
      for (const [id, zh] of Object.entries(r.ok)) {
        const hash = hashOf.get(id)!;
        store.put(hash, zh, config, gl);
        forceUnits.delete(id);
        units[id] = { zh, srcHash: hash };
      }
      progress.done += Object.keys(units).length;
      const failed: Record<string, string> = {};
      for (const id of r.failed) {
        failedUnits.add(id);
        failed[id] = r.problems.at(-1) ?? "翻译失败";
      }
      progress.failed += r.failed.length;
      if (r.failed.length) message = r.problems.at(-1);
      emit({ type: "translations", units, failed });
    } catch (e: any) {
      if (gen !== generation || disposed) return;
      for (const id of batch.ids) failedUnits.add(id);
      progress.failed += batch.ids.length;
      message = e?.message ?? String(e);
      Zotero.debug(`[zbr] batch failed: ${message}`);
      emit({ type: "translations", units: {}, failed: Object.fromEntries(batch.ids.map((id) => [id, message!])) });
    } finally {
      if (gen === generation) {
        running--;
        for (const id of batch.ids) inFlight.delete(id);
        if (!disposed && !signal.aborted) {
          emitProgress(message);
          void pump();
          scheduleIdleCleanup();
        }
      }
    }
  }

  // Paper glossary: one short request before batch translation fixes the key terms of this paper,
  // so separately translated paragraphs agree. Batches that start before it is ready use the
  // reader's own glossary only.
  let glossaryJob: Promise<void> | null = null;
  let glossaryTried = false;
  function ensurePaperGlossary(engine: Engine, doc: ZbrDocument, store: TranslationStore) {
    // One attempt per opened paper; a failure just means batches go without it.
    if (store.glossary || glossaryJob || glossaryTried) return;
    glossaryTried = true;
    const gen = generation;
    glossaryJob = (async () => {
      try {
        const text = parseGlossary(await engine.complete(glossaryPrompt(doc), controller.signal));
        if (gen !== generation || disposed) return;
        // An empty answer is not stored: the next time the paper is opened it is asked again.
        if (!text) throw new Error("no terms in the answer");
        store.glossary = text;
        Zotero.debug(`[zbr] paper glossary: ${text.split("\n").length} terms`);
      } catch (e) {
        Zotero.debug(`[zbr] paper glossary failed: ${e}`);
      } finally {
        glossaryJob = null;
        scheduleIdleCleanup();
      }
    })();
  }

  /** grok session records of the plugin's own calls are removed once nothing is running. */
  let cleanupTimer: number | undefined;
  function scheduleIdleCleanup() {
    clearTimeout(cleanupTimer);
    cleanupTimer = setTimeout(() => {
      if (running === 0 && !jobs.length && !queue.length && !glossaryJob) void cleanupAgentSessions();
    }, 5000);
  }

  // Whole-paper translation by an agent the reader runs in their own window: the plugin writes a
  // task folder and watches it. Everything shown (progress, phase, last activity) comes from the
  // files the agent writes, so it works with any agent and never pretends to know more.
  const jobDir = () => PathUtils.join(Zotero.DataDirectory.dir, "zotero-bilingual-reader", "jobs", TranslationStore.fileName(attachment.libraryID, attachment.key).replace(/\.json$/, ""));
  const JOB_FILE = "job.json";
  /** Files the plugin writes itself; they say nothing about the agent's activity. */
  const OWN_FILES = new Set(["units.json", "TASK.md", JOB_FILE, FIX_FILE, "FIX.md"]);
  let handoff: { info: HandoffInfo; expected: Map<string, Expected>; shown: Map<string, string>; timer?: number; fixAt?: number } | null = null;

  async function readJSONQuiet(path: string): Promise<unknown> {
    try {
      return (await IOUtils.exists(path)) ? await IOUtils.readJSON(path) : null;
    } catch {
      return null; // being written right now; read again on the next poll
    }
  }

  async function listFiles(dir: string): Promise<string[]> {
    if (!(await IOUtils.exists(dir))) return [];
    const out: string[] = [];
    for (const p of await IOUtils.getChildren(dir)) {
      const st = await IOUtils.stat(p).catch(() => null);
      if (st?.type === "directory") out.push(...(await listFiles(p)));
      else if (st) out.push(p);
    }
    return out;
  }

  const emitHandoff = () => handoff && emit({ type: "handoff", handoff: { ...handoff.info } });

  async function pollHandoff(): Promise<Collected | null> {
    if (!handoff || disposed) return null;
    const h = handoff;
    const { dir } = h.info;
    const { store } = await ready;
    const files = await listFiles(dir);
    const parts = files.filter((p) => p.startsWith(PathUtils.join(dir, PARTS_DIR)) && p.endsWith(".json")).sort();
    const results: unknown[] = [];
    for (const p of parts) results.push(await readJSONQuiet(p));
    for (const name of [RESULT_FILE, FIX_RESULT_FILE]) results.push(await readJSONQuiet(PathUtils.join(dir, name)));
    const r = collect(results, h.expected);
    if (handoff !== h) return null;
    const units: Record<string, UnitTranslation> = {};
    for (const [id, zh] of Object.entries(r.ok)) {
      if (h.shown.get(id) === zh) continue;
      h.shown.set(id, zh);
      const { hash } = h.expected.get(id)!;
      store.put(hash, zh, "handoff", "");
      failedUnits.delete(id);
      units[id] = { zh, srcHash: hash };
    }
    if (Object.keys(units).length) emit({ type: "translations", units });
    let lastWrite = 0;
    for (const p of files) {
      if (OWN_FILES.has(PathUtils.filename(p))) continue;
      const st = await IOUtils.stat(p).catch(() => null);
      if (st?.lastModified) lastWrite = Math.max(lastWrite, st.lastModified);
    }
    const report = files.some((p) => PathUtils.filename(p) === "report.md" && PathUtils.parent(p) === dir);
    // After a fix task, the job is done again once its answer file appears.
    const fixDone = h.fixAt ? files.some((p) => PathUtils.filename(p) === FIX_RESULT_FILE) : true;
    Object.assign(h.info, {
      delivered: Object.keys(r.ok).length,
      bad: Object.keys(r.bad).length,
      lastWrite: lastWrite || undefined,
      phase: handoffPhase({
        glossary: files.some((p) => PathUtils.filename(p) === "glossary.md"),
        delivered: Object.keys(r.ok).length + Object.keys(r.bad).length,
        todo: h.info.todo,
        report: report && fixDone,
      }),
    });
    // A finished job is read once more and then left alone.
    if (h.info.phase === "done" && h.info.delivered >= h.info.todo) h.info.watching = false;
    emitHandoff();
    return r;
  }

  function watchHandoff() {
    if (!handoff) return;
    const h = handoff;
    clearTimeout(h.timer);
    h.info.watching = true;
    const tick = async () => {
      await pollHandoff().catch((e) => Zotero.logError(e));
      if (handoff === h && h.info.watching && !disposed) h.timer = setTimeout(() => void tick(), 3000);
    };
    void tick();
  }

  /** Rebuild the watcher of an existing task folder (e.g. after the paper is reopened). */
  async function loadHandoff(): Promise<boolean> {
    const dir = jobDir();
    const job = (await readJSONQuiet(PathUtils.join(dir, JOB_FILE))) as { startedAt?: number; todo?: string[]; fixAt?: number } | null;
    if (!job?.todo?.length) return false;
    const doc = await activeDoc();
    const ids = new Set(job.todo);
    const expected = expectedUnits(doc, ids);
    // The task belongs to the text source it was made from; another source has other ids.
    if (!expected.size) return false;
    handoff = {
      info: { dir, prompt: startPrompt(dir), commands: startCommands(dir), todo: expected.size, delivered: 0, bad: 0, phase: "waiting", startedAt: job.startedAt ?? Date.now(), watching: true, fixPrompt: job.fixAt ? fixPrompt(dir) : undefined },
      expected,
      shown: new Map(),
      fixAt: job.fixAt,
    };
    await pollHandoff();
    if (handoff.info.watching) watchHandoff();
    return true;
  }
  const handoffLoaded = ready.then(() => loadHandoff()).catch((e) => {
    Zotero.logError(e);
    return false;
  });

  // Highlights: existing PDF annotations mapped onto sentences by geometry, refreshed when
  // annotations of this attachment change (here or in the PDF reader).
  let lastHighlights = "";
  async function readHighlights(): Promise<HighlightView[]> {
    const { locator } = await ready;
    const out: HighlightView[] = [];
    for (const a of attachment.getAnnotations() as any[]) {
      if (a.annotationType !== "highlight" && a.annotationType !== "underline") continue;
      let pos: any;
      try {
        pos = JSON.parse(a.annotationPosition);
      } catch {
        continue;
      }
      if (typeof pos?.pageIndex !== "number" || !Array.isArray(pos.rects)) continue;
      const unitIds = locator.unitsAt({ pageIndex: pos.pageIndex, rects: pos.rects });
      if (pos.nextPageRects) unitIds.push(...locator.unitsAt({ pageIndex: pos.pageIndex + 1, rects: pos.nextPageRects }));
      if (!unitIds.length) continue;
      // The same highlight on the MinerU source's sentences, when there is one.
      const al = mineruItems ? await getAlignment() : null;
      if (al) unitIds.push(...new Set(unitIds.flatMap((id) => al.toMineru.get(id) ?? [])));
      out.push({ id: a.key, color: a.annotationColor, unitIds, text: a.annotationText, comment: a.annotationComment || undefined });
    }
    return out;
  }
  /** An annotation of this PDF by key; never touches items of other attachments. */
  function ownAnnotation(key: string): any {
    const a = (Zotero.Items as any).getByLibraryAndKey(attachment.libraryID, key);
    if (!a || !a.isAnnotation() || a.parentID !== attachment.id) throw new Error("找不到这条高亮");
    return a;
  }
  async function refreshHighlights() {
    if (disposed) return;
    const highlights = await readHighlights();
    const json = JSON.stringify(highlights);
    if (json === lastHighlights) return;
    lastHighlights = json;
    emit({ type: "highlights", highlights });
  }
  let notifyTimer: number | undefined;
  const observerID = Zotero.Notifier.registerObserver(
    {
      notify(_event: string, _type: string, ids: (number | string)[], extraData: any) {
        const ours = ids.some((id) => {
          const parent = (Zotero.Items.get(id as number) as any)?.parentItemID ?? extraData?.[id]?.parentItemID;
          return parent === attachment.id || parent === undefined;
        });
        if (!ours) return;
        clearTimeout(notifyTimer);
        notifyTimer = setTimeout(() => void refreshHighlights().catch((e) => Zotero.logError(e)), 300);
      },
    } as any,
    ["item"],
    "zbr-highlights",
  );

  // Translations written to this paper's cache file by another program (the batch CLI, another
  // window) appear on the open page: a cheap modification-time check every few seconds.
  let cacheTimer: number | undefined;
  let seenRev = -1;
  const watchCache = async () => {
    if (disposed) return;
    try {
      const { store } = await ready;
      await store.refresh();
      // Also changes made in this session by another host of the same paper (pre-translation).
      if (seenRev >= 0 && store.rev !== seenRev && !running && !jobs.length) {
        const doc = await activeDoc();
        const units: Record<string, UnitTranslation> = {};
        for (const b of doc.blocks)
          for (const s of b.sentences) {
            const c = store.get(s.hash);
            if (c && !inFlight.has(s.id) && shown.get(s.id) !== c.zh) units[s.id] = { zh: c.zh, srcHash: s.hash };
          }
        if (Object.keys(units).length) {
          emit({ type: "translations", units, failed: {} });
          emitProgress();
        }
      }
      if (!running && !jobs.length) {
        // First idle look: what the cache holds now is what the page loaded.
        if (seenRev < 0) {
          const doc = await activeDoc();
          for (const b of doc.blocks)
            for (const s of b.sentences) {
              const c = store.get(s.hash);
              if (c && !shown.has(s.id)) shown.set(s.id, c.zh);
            }
        }
        seenRev = store.rev;
      }
    } catch (e) {
      Zotero.logError(e as Error);
    }
    if (!disposed) cacheTimer = setTimeout(() => void watchCache(), CACHE_CHECK_MS);
  };
  cacheTimer = setTimeout(() => void watchCache(), CACHE_CHECK_MS);

  const host: ZoteroHost = {
    capabilities: { openInPdf: true, highlights: true },

    getProgressSnapshot() {
      return { ...progress };
    },
    pdfjs: { lib: "resource://zotero/reader/pdf/build/pdf.mjs", worker: "resource://zotero/reader/pdf/build/pdf.worker.mjs" },

    async getDocument() {
      return activeDoc();
    },

    async getTranslations() {
      const { store } = await ready;
      const doc = await activeDoc();
      const out: Record<string, UnitTranslation> = {};
      for (const b of doc.blocks) {
        for (const s of b.sentences) {
          const c = store.get(s.hash);
          if (c) out[s.id] = { zh: c.zh, srcHash: s.hash };
        }
      }
      return out;
    },

    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    async translate(req) {
      const gen = generation;
      const { store, blocks } = await ready;
      const doc = await activeDoc();
      // A cancel() while we were waiting for the document wins over this request.
      if (gen !== generation || disposed) return;
      const ids = req.all ? doc.blocks.filter((b) => b.translatable).map((b) => b.id) : (req.blockIds ?? []);
      if (req.retryFailed) {
        // Only the failures inside the requested paragraphs are retried.
        for (const id of ids) {
          for (const s of blocks.get(id)?.sentences ?? []) {
            if (failedUnits.delete(s.id)) progress.failed = Math.max(0, progress.failed - 1);
          }
        }
      }
      const fresh: string[] = [];
      for (const id of ids) {
        const b = blocks.get(id);
        if (!b?.translatable) continue;
        if (req.retranslate) {
          for (const s of b.sentences) {
            if (inFlight.has(s.id)) continue;
            forceUnits.add(s.id);
            // Asking again for these paragraphs retries their failed units (and only theirs).
            if (failedUnits.delete(s.id)) progress.failed = Math.max(0, progress.failed - 1);
          }
        }
        if (queued.has(id)) continue;
        const n = b.sentences.filter((s) => needs(s, store)).length;
        if (!n) continue;
        queued.add(id);
        fresh.push(id);
        progress.total += n;
      }
      // What the reader is looking at now goes first; a full-text request goes to the back.
      if (req.all) queue.push(...fresh);
      else queue.unshift(...fresh);
      await pump();
    },

    async cancel() {
      generation++;
      controller.abort();
      controller = newAbortController();
      queue.length = 0;
      queued.clear();
      jobs.length = 0;
      inFlight.clear();
      forceUnits.clear();
      running = 0;
      progress.total = progress.done;
      emitProgress("已停止");
    },

    async editTranslation(unitId, zh) {
      const { store, blocks } = await ready;
      await activeDoc();
      const s = blocks.get(unitId.slice(0, unitId.lastIndexOf(":")))?.sentences.find((x) => x.id === unitId);
      if (!s) throw new Error("找不到这个句子");
      const text = zh.trim();
      if (!text) throw new Error("译文不能为空");
      // "manual" marks the reader's own wording; nothing automatic replaces a cached sentence.
      store.put(s.hash, text, "manual", "");
      failedUnits.delete(unitId);
      emit({ type: "translations", units: { [unitId]: { zh: text, srcHash: s.hash } } });
    },

    async clearTranslations(scope = "all") {
      await host.cancel();
      const { store } = await ready;
      if (scope === "source") {
        // Sentences of the source on screen; the same sentence in the other source shares the entry.
        store.remove((await activeDoc()).blocks.flatMap((b) => b.sentences.map((s) => s.hash)));
      } else store.clear();
      await store.flush();
      progress.done = progress.total = progress.failed = 0;
      failedUnits.clear();
      shown.clear();
      glossaryTried = false;
      emitProgress("已清除本篇译文");
    },

    async getPaperGlossary() {
      return (await ready).store.glossary ?? null;
    },
    async setPaperGlossary(text) {
      (await ready).store.glossary = text.trim();
    },

    async startHandoff(opts) {
      await handoffLoaded;
      if (handoff && !opts?.fresh) {
        if (!handoff.info.watching && handoff.info.phase !== "done") watchHandoff();
        return { ...handoff.info };
      }
      if (handoff) clearTimeout(handoff.timer);
      handoff = null;
      const { store } = await ready;
      const doc = await activeDoc();
      // Untranslated sentences only; everything already translated is given as context.
      const todo = new Set<string>();
      for (const b of doc.blocks) if (b.translatable) for (const s of b.sentences) if (!store.get(s.hash)) todo.add(s.id);
      if (!todo.size) throw new Error("这篇论文已经全部译完；要整篇重译，先点“清除译文”");
      const dir = jobDir();
      await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
      await IOUtils.makeDirectory(PathUtils.join(dir, PARTS_DIR), { createAncestors: true, ignoreExisting: true });
      const all = doc.blocks.reduce((n, b) => n + (b.translatable ? b.sentences.length : 0), 0);
      const gl = mergeGlossaries(glossary(), store.glossary ?? "");
      await IOUtils.writeUTF8(PathUtils.join(dir, "units.json"), JSON.stringify(buildUnitsFile(doc, todo, (h) => store.get(h)?.zh), null, 1));
      await IOUtils.writeUTF8(PathUtils.join(dir, "TASK.md"), taskText({ dir, title: doc.title, glossary: gl, todo: todo.size, partial: todo.size < all, math: doc.blocks.some((b) => b.inlineMath) }));
      const startedAt = Date.now();
      await IOUtils.writeJSON(PathUtils.join(dir, JOB_FILE), { startedAt, todo: [...todo] });
      await loadHandoff();
      return { ...handoff!.info };
    },

    async getHandoff() {
      await handoffLoaded;
      return handoff ? { ...handoff.info } : null;
    },

    async handoffFix() {
      await handoffLoaded;
      if (!handoff) return null;
      const h = handoff;
      const r = await pollHandoff();
      if (!r) return null;
      const left = [...h.expected.keys()].filter((id) => !(id in r.ok));
      if (!left.length) return null;
      const { dir } = h.info;
      // Missing sentences have no problem text; the task explains that empty means "not delivered".
      const items: FixItem[] = left.map((id) => ({ id, en: h.expected.get(id)!.en, problem: r.bad[id] ?? "" }));
      // A new fix round replaces the previous answer file.
      await IOUtils.remove(PathUtils.join(dir, FIX_RESULT_FILE), { ignoreAbsent: true });
      await IOUtils.writeUTF8(PathUtils.join(dir, FIX_FILE), JSON.stringify(items, null, 1));
      await IOUtils.writeUTF8(PathUtils.join(dir, "FIX.md"), fixText(items.length, dir));
      h.fixAt = Date.now();
      const job: any = (await readJSONQuiet(PathUtils.join(dir, JOB_FILE))) ?? {};
      await IOUtils.writeJSON(PathUtils.join(dir, JOB_FILE), { ...job, fixAt: h.fixAt });
      h.info.fixPrompt = fixPrompt(dir);
      watchHandoff();
      return h.info.fixPrompt;
    },

    async stopHandoff() {
      await handoffLoaded;
      if (!handoff) return;
      clearTimeout(handoff.timer);
      handoff.info.watching = false;
      emitHandoff();
    },

    async openHandoffFile(which) {
      await handoffLoaded;
      if (!handoff) return;
      const path = which === "report" ? PathUtils.join(handoff.info.dir, "report.md") : handoff.info.dir;
      if (which === "report") Zotero.launchFile(path);
      else Zotero.File.reveal(PathUtils.join(path, "TASK.md"));
    },

    getEngines: listEngines,
    getPdfData,

    async getEnrichment() {
      const items = await loadMineru();
      if (!items) return null;
      const { doc } = await ready;
      return matchMineru(doc, items) as Record<string, Enrichment>;
    },

    async hasMineru() {
      return !!(await loadMineru());
    },

    async mineruReady() {
      return !!String(getPref("mineruToken") || "").trim();
    },

    async setMineruToken(token: string) {
      setPref("mineruToken", token.trim());
    },

    openUrl(url: string) {
      if (/^https:\/\//.test(url)) Zotero.launchURL(url);
    },

    async parseMineru() {
      const token = String(getPref("mineruToken") || "").trim();
      if (!token) throw new Error("还没有填写 MinerU API Token（设置 → 双语阅读 → MinerU）");
      const pdf = await getPdfData();
      const labels: Record<string, string> = { uploading: "上传 PDF", "waiting-file": "等待文件", pending: "排队中", running: "解析中", converting: "整理结果", downloading: "下载结果" };
      emitProgress("MinerU：提交中…");
      try {
        const items = await parseOnMineruCloud({
          token,
          pdf,
          name: String(attachment.attachmentFilename || `${attachment.key}.pdf`),
          onProgress: (p) => emitProgress(`MinerU：${labels[p.state] ?? p.state}${p.total ? ` ${p.pages ?? 0}/${p.total} 页` : ""}…`),
        });
        const dir = mineruDir();
        await IOUtils.makeDirectory(PathUtils.join(dir, "raw"), { createAncestors: true, ignoreExisting: true });
        await IOUtils.writeJSON(PathUtils.join(dir, "raw", "content_list.json"), items);
        await IOUtils.writeJSON(PathUtils.join(dir, "parse.json"), {
          provider: "mineru-cloud",
          backend: "vlm",
          status: "complete",
          pdfSha256: await sha256Hex(pdf),
          completedAt: new Date().toISOString(),
        });
        mineruItems = null;
        mineruDoc = null;
        alignment = null;
        emitProgress("MinerU 解析完成");
      } catch (e: any) {
        emitProgress(`MinerU 解析失败：${e?.message ?? e}`);
        throw e;
      }
    },

    async openInPdf(target) {
      const { locator, blocks } = await ready;
      const block = blocks.get(target.blockId);
      if (!block) return;
      let pos: PagePosition | undefined = undefined;
      for (const p of await sdtPieces(target.unitIds ?? [])) {
        pos = mergeLineRects(locator.charRects(p.block, p.start, p.end))[0];
        if (pos) break;
      }
      if (!pos && block.pageRects.length) {
        const [pageIndex, x1, y1, x2, y2] = block.pageRects[0];
        pos = { pageIndex, rects: [[x1, y1, x2, y2]] };
      }
      // The PDF view scrolls to the position and flashes it.
      await (Zotero as any).Reader.open(attachment.id, pos ? { position: pos } : undefined);
    },

    async getHighlights() {
      return readHighlights();
    },

    async createHighlight(req) {
      const { doc, locator } = await ready;
      // Character rects of every selected sentence, in reading order; MinerU sentences through
      // the Zotero text they were aligned with.
      const pieces = await sdtPieces(req.unitIds);
      if (!pieces.length) throw new Error("所选句子没有对应的 PDF 位置");
      const chars = pieces.flatMap((p) => locator.charRects(p.block, p.start, p.end).map((c) => ({ ...c, piece: p, block: p.block })));
      const pages = [...new Set(chars.map((c) => c.pageIndex))];
      if (!pages.length) throw new Error("所选句子没有对应的 PDF 位置");
      // Zotero highlights live on one page each; a selection across pages becomes one per page.
      for (const pageIndex of pages) {
        const onPage = chars.filter((c) => c.pageIndex === pageIndex);
        const [pos] = mergeLineRects(onPage);
        const first = onPage[0];
        const pagePieces = [...new Set(onPage.map((c) => c.piece))];
        const height = doc.pages[pageIndex]?.height ?? 792;
        const top = Math.max(0, Math.floor(height - Math.max(...pos.rects.map((r) => r[3]))));
        const offset = locator.pageOffset(first.block, first.piece.start);
        const pad = (n: number, w: number) => String(Math.max(0, Math.min(n, 10 ** w - 1))).padStart(w, "0");
        await (Zotero as any).Annotations.saveFromJSON(attachment, {
          key: (Zotero as any).DataObjectUtilities.generateKey(),
          type: "highlight",
          text: pagePieces.map((p) => p.block.text.slice(p.start, p.end).trim()).join(" "),
          comment: req.comment ?? "",
          color: req.color,
          pageLabel: doc.pages[pageIndex]?.label ?? String(pageIndex + 1),
          sortIndex: `${pad(pageIndex, 5)}|${pad(offset, 6)}|${pad(top, 5)}`,
          position: { pageIndex, rects: pos.rects.map((r) => r.map((v) => Math.round(v * 1000) / 1000)) },
          tags: [],
        });
      }
      await refreshHighlights();
    },

    async updateHighlight(req) {
      const a = ownAnnotation(req.id);
      if (req.comment !== undefined) a.annotationComment = req.comment;
      if (req.color !== undefined) a.annotationColor = req.color;
      await a.saveTx();
      await refreshHighlights();
    },

    async deleteHighlight(id) {
      // Same as deleting it in Zotero's reader.
      await ownAnnotation(id).eraseTx();
      await refreshHighlights();
    },

    async openHighlight(id) {
      ownAnnotation(id);
      await (Zotero as any).Reader.open(attachment.id, { annotationID: id });
    },

    async getPosition() {
      return (await ready).store.position ?? null;
    },
    async setPosition(blockId) {
      (await ready).store.position = blockId;
    },
    async getBookmarks() {
      return (await ready).store.bookmarks;
    },
    async setBookmarks(list) {
      (await ready).store.bookmarks = list;
    },

    async getPrefs() {
      return readPrefs();
    },
    async setPrefs(p) {
      setPref("readerPrefs", JSON.stringify({ ...readPrefs(), ...p, v: 2 }));
    },

    dispose() {
      disposed = true;
      if (handoff) clearTimeout(handoff.timer);
      clearTimeout(cleanupTimer);
      Zotero.Notifier.unregisterObserver(observerID);
      clearTimeout(notifyTimer);
      clearTimeout(cacheTimer);
      generation++;
      controller.abort();
      listeners.clear();
      void ready.then(({ store }) => store.flush()).catch(() => {});
    },
  };
  return host;
}
