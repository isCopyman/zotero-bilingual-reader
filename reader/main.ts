import { DEFAULT_PREFS, type DocSource, type Theme, type Granularity, type HighlightView, type Mode, type PairStyle, type PeekStyle, type ReaderPrefs, type RichStyle, type TranslationProgress, type ZbrHost } from "../core/host-api";
import type { Enrichment } from "../core/mineru";
import type { Block, ZbrDocument } from "../core/model";
import { installBlockAction } from "./block-action";
import { observeFigures } from "./figures";
import { ICONS, installOutline, type OutlineTab } from "./outline";
import { openMineruDialog } from "./mineru-dialog";
import { installSearch } from "./search";
import { handoffStatus, initHandoff, modal, openGlossary, openHandoff } from "./handoff";
import { installInteractions } from "./interact";
import { setRich } from "./richtext";
import { indexSpans, spansOf } from "./spans";
import { isBlockTranslated, renderBlock, translationFor, type Translations } from "./render";

interface State {
  host: ZbrHost;
  doc: ZbrDocument;
  blocks: Map<string, Block>;
  tr: Translations;
  prefs: ReaderPrefs;
  progress: TranslationProgress;
  /** Formulas and tables to show: MinerU matches for the Zotero document, or the MinerU document's own. */
  enrich: Record<string, Enrichment> | null;
  /** MinerU matches for the Zotero document, kept while the MinerU document is shown. */
  sdtEnrich: Record<string, Enrichment> | null;
  hasMineru: boolean;
  highlights: HighlightView[];
}

const isMineruDoc = () => state.doc.parser.kind === "mineru";

/** The MinerU document carries its formulas and tables itself. */
function enrichmentFor(doc: ZbrDocument): Record<string, Enrichment> | null {
  if (doc.parser.kind !== "mineru") return state.sdtEnrich;
  const out: Record<string, Enrichment> = {};
  for (const b of doc.blocks) if (b.mineru) out[b.id] = { latex: b.mineru.latex, tableHtml: b.mineru.tableHtml };
  return out;
}

/** Show the document of the chosen source (text, translations and figures). */
async function switchSource(source: DocSource) {
  await setPrefs({ source }, false);
  const [doc, tr] = await Promise.all([state.host.getDocument(), state.host.getTranslations()]);
  state.doc = doc;
  state.blocks.clear();
  for (const b of doc.blocks) state.blocks.set(b.id, b);
  state.tr = tr;
  state.enrich = enrichmentFor(doc);
  window.scrollTo(0, 0);
  renderAll();
  await restorePosition();
}

let state: State;
let figObserver: IntersectionObserver | null = null;
let autoObserver: IntersectionObserver | null = null;

function $(sel: string) {
  return document.querySelector(sel) as HTMLElement;
}

function toast(msg: string) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

async function waitForHost(): Promise<ZbrHost> {
  if (window.zbrHost) return window.zbrHost;
  return new Promise((resolve) => {
    window.addEventListener("zbr-host-ready", () => resolve(window.zbrHost!), { once: true });
  });
}

function firstVisibleBlock(): string | null {
  for (const s of Array.from(document.querySelectorAll<HTMLElement>("section.blk"))) {
    const r = s.getBoundingClientRect();
    if (r.bottom > 60) return s.dataset.b!;
  }
  return null;
}

let finder: ReturnType<typeof installSearch> | undefined;
let outline: ReturnType<typeof installOutline> | undefined;

function renderAll() {
  const t0 = performance.now();
  const anchor = firstVisibleBlock();
  const main = $("#doc");
  main.className = `mode-${state.prefs.mode}`;
  document.documentElement.style.setProperty("--fs", `${state.prefs.fontSize}px`);
  const frag = document.createDocumentFragment();
  let lastPage = -1;
  const rich = state.prefs.rich === "mineru" && state.enrich;
  for (const b of state.doc.blocks) {
    // Text fragments that belong to a MinerU-rebuilt equation are shown by that equation.
    if (rich && rich[b.id]?.coveredBy && b.kind !== "math") continue;
    const page = b.pageRects[0]?.[0] ?? lastPage;
    if (page > lastPage) {
      const marker = document.createElement("div");
      marker.className = "page-marker";
      marker.textContent = `第 ${page + 1} 页`;
      marker.dataset.page = String(page);
      frag.append(marker);
      lastPage = page;
    }
    frag.append(renderBlock(b, state.prefs.mode, state.tr));
  }
  main.replaceChildren(frag);
  indexSpans(main);
  finder?.refresh();
  outline?.refresh();
  figObserver?.disconnect();
  figObserver = observeFigures({ host: state.host, root: main, blocks: state.blocks, enrich: state.enrich, getRich: () => (isMineruDoc() ? "mineru" : state.prefs.rich), toast });
  setupAutoTranslate();
  applyHighlights();
  if (anchor) document.querySelector(`section.blk[data-b="${CSS.escape(anchor)}"]`)?.scrollIntoView({ block: "start" });
  syncToolbar();
  // Includes the forced layout of scrollIntoView; read by the performance test.
  performance.measure("zbr-render", { start: t0, end: performance.now() });
}

let marked: HTMLElement[] = [];

/** Tint sentences covered by PDF highlights in both languages; the comment shows as a tooltip. */
function applyHighlights() {
  for (const el of marked) {
    el.classList.remove("marked");
    el.style.removeProperty("--mark");
    el.removeAttribute("title");
  }
  marked = [];
  outline?.refreshNotes();
  for (const h of state.highlights) {
    for (const id of h.unitIds) {
      spansOf(id).forEach((el) => {
        marked.push(el);
        el.classList.add("marked");
        el.style.setProperty("--mark", h.color);
        if (h.comment) el.title = h.comment;
      });
    }
  }
}

function applyTranslations(units: Translations) {
  // The host re-sends whole papers (cache file changed on disk); only changed sentences are
  // redrawn, so the page is not laid out again from scratch.
  const changed = Object.keys(units).filter((id) => state.tr[id]?.zh !== units[id].zh || state.tr[id]?.srcHash !== units[id].srcHash);
  if (!changed.length) return updateProgressText();
  Object.assign(state.tr, units);
  const touched = new Set<string>();
  for (const id of changed) {
    const blockId = id.slice(0, id.lastIndexOf(":"));
    const block = state.blocks.get(blockId);
    const s = block?.sentences.find((x) => x.id === id);
    if (!block || !s) continue;
    const zh = translationFor(s, state.tr);
    if (zh === undefined) continue;
    spansOf(id).forEach((el) => {
      if (!el.closest(".zh")) return;
      setRich(el, zh, block.inlineMath);
      el.classList.remove("pending");
    });
    touched.add(blockId);
  }
  for (const bid of touched) {
    const block = state.blocks.get(bid)!;
    document.querySelector(`section.blk[data-b="${CSS.escape(bid)}"]`)?.classList.toggle("done", isBlockTranslated(block, state.tr));
  }
  // The outline shows headings with their translations.
  if ([...touched].some((bid) => state.blocks.get(bid)?.kind === "heading")) outline?.refreshToc();
  updateProgressText();
}

function translatableCount() {
  return state.doc.blocks.reduce((n, b) => n + (b.translatable ? b.sentences.length : 0), 0);
}

function translatedCount() {
  let n = 0;
  for (const b of state.doc.blocks) for (const s of b.sentences) if (b.translatable && translationFor(s, state.tr)) n++;
  return n;
}

/** Sentences whose last translation attempt failed, with the reason. */
const failedUnits = new Map<string, string>();

function retryFailed() {
  const blockIds = [...new Set([...failedUnits.keys()].map((id) => id.slice(0, id.lastIndexOf(":"))))];
  failedUnits.clear();
  // Without the ids (failures from before this page opened) retry them across the paper.
  const req = blockIds.length ? { blockIds, retryFailed: true } : { all: true, retryFailed: true };
  state.host.translate(req).catch((err) => toast(`翻译失败：${err?.message ?? err}`));
}

/** MinerU enrichment (reads and hashes the PDF); again after an in-reader MinerU parse. */
function loadEnrichment() {
  void state.host
    .getEnrichment()
    .then((enrich) => {
      state.sdtEnrich = enrich;
      state.hasMineru = !!enrich;
      state.enrich = enrichmentFor(state.doc);
      if (enrich) renderAll();
      else syncToolbar();
    })
    .catch(() => {});
}

function updateProgressText() {
  const p = state.progress;
  const done = translatedCount();
  const total = translatableCount();
  const el = $("#progress");
  const agent = handoffStatus();
  el.textContent = `已译 ${done}/${total}` + (p.running ? " · 翻译中…" : "");
  if (p.failed) {
    el.append(" · ");
    // Failed sentences are retried on their own; the rest of the paper is left as it is.
    const retry = document.createElement("button");
    retry.id = "btn-retry-failed";
    retry.className = "link";
    retry.textContent = `失败 ${p.failed} 句，重试`;
    retry.title = failedUnits.size ? [...failedUnits.values()].slice(-3).join("\n") : "重试翻译失败的句子";
    retry.disabled = p.running;
    retry.addEventListener("click", retryFailed);
    el.append(retry);
  }
  el.append((p.message ? ` · ${p.message}` : "") + (agent ? ` · ${agent}` : ""));
  $("#btn-translate").textContent = p.running ? "停止" : done >= total ? "已全部翻译" : "翻译全文";
  ($("#btn-translate") as HTMLButtonElement).disabled = !p.running && done >= total;
}

// Auto-translate batches what scrolls near the viewport. "停止" pauses it until the user starts
// translation again or re-enables it, so scrolling does not silently restart paid work.
let autoTimer: number | undefined;
let autoPending = new Set<string>();
let autoPaused = false;

function clearAutoQueue() {
  clearTimeout(autoTimer);
  autoTimer = undefined;
  autoPending = new Set();
}

function setupAutoTranslate() {
  autoObserver?.disconnect();
  clearAutoQueue();
  if (autoPaused || !state.prefs.autoTranslate || (state.prefs.mode === "en" && state.prefs.peek === "off")) return;
  autoObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const bid = (e.target as HTMLElement).dataset.b!;
        const b = state.blocks.get(bid);
        if (b?.translatable && !isBlockTranslated(b, state.tr)) autoPending.add(bid);
      }
      if (autoPending.size && autoTimer === undefined) {
        autoTimer = window.setTimeout(() => {
          const ids = [...autoPending];
          clearAutoQueue();
          if (autoPaused) return;
          state.host.translate({ blockIds: ids }).catch((err) => toast(`翻译请求失败：${err?.message ?? err}`));
        }, 400);
      }
    },
    { rootMargin: "1200px 0px" },
  );
  document.querySelectorAll<HTMLElement>("section.blk").forEach((s) => autoObserver!.observe(s));
}

async function setPrefs(p: Partial<ReaderPrefs>, rerender = true) {
  state.prefs = { ...state.prefs, ...p };
  await state.host.setPrefs(p);
  if (rerender) renderAll();
  else syncToolbar();
}

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
/** The page theme as a data attribute; "auto" resolves to Zotero's current light/dark appearance. */
function applyTheme() {
  const t = state.prefs.theme ?? "auto";
  document.documentElement.dataset.theme = t === "auto" ? (darkQuery.matches ? "dark" : "light") : t;
  // Mark of the sentence pair under the mouse; a chosen colour overrides the theme's.
  document.documentElement.dataset.pair = state.prefs.pairStyle ?? "frame";
  if (state.prefs.pairColor) document.documentElement.style.setProperty("--pair", state.prefs.pairColor);
  else document.documentElement.style.removeProperty("--pair");
}
darkQuery.addEventListener("change", () => applyTheme());

function syncToolbar() {
  applyTheme();
  ($("#opt-theme") as HTMLSelectElement).value = state.prefs.theme ?? "auto";
  ($("#opt-pair") as HTMLSelectElement).value = state.prefs.pairStyle ?? "frame";
  ($("#opt-pair-color") as HTMLInputElement).value = state.prefs.pairColor || getComputedStyle(document.documentElement).getPropertyValue("--pair").trim() || "#2563eb";
  document.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === state.prefs.mode));
  document.querySelectorAll<HTMLElement>("[data-gran]").forEach((b) => b.classList.toggle("on", b.dataset.gran === String(state.prefs.granularity)));
  ($("#opt-peek") as HTMLSelectElement).value = state.prefs.peek;
  ($("#opt-rich") as HTMLSelectElement).value = state.prefs.rich;
  $("#opt-rich").hidden = !state.enrich || isMineruDoc();
  ($("#opt-source") as HTMLSelectElement).value = state.doc.parser.kind === "mineru" ? "mineru" : "zotero";
  $("#opt-source").hidden = !state.hasMineru;
  $("#btn-mineru").hidden = state.hasMineru || !state.host.parseMineru;
  $("#opt-peek").classList.toggle("dim", state.prefs.mode === "interleave" || state.prefs.mode === "side");
  ($("#opt-auto") as HTMLInputElement).checked = state.prefs.autoTranslate;
  ($("#opt-hlzh") as HTMLInputElement).checked = state.prefs.highlightWithZh;
  $("#opt-hlzh-wrap").hidden = !state.host.capabilities.highlights;
  updateProgressText();
}

/**
 * Static markup -> nodes. Inside Zotero the page is privileged chrome, where innerHTML is
 * sanitized and silently drops form controls such as <select>; a parsed document is not.
 */
function html(markup: string): DocumentFragment {
  const parsed = new DOMParser().parseFromString(`<body>${markup}</body>`, "text/html");
  const frag = document.createDocumentFragment();
  for (const n of Array.from(parsed.body.childNodes)) frag.append(document.importNode(n, true));
  return frag;
}

function buildToolbar() {
  const bar = $("#toolbar");
  bar.replaceChildren(html(`
    <button id="btn-back-pdf" class="icon" title="返回 PDF（双语视图保留，再点 PDF 工具栏上的双语图标回来）" hidden>${ICONS.pdf}</button>
    <button id="btn-outline" class="icon" title="侧栏：目录、书签和注释（快捷键 T）">${ICONS.sidebar}</button>
    <div class="title" id="title"></div>
    <div class="seg" title="显示模式">
      <button data-mode="en" title="快捷键 1">英文</button><button data-mode="interleave" title="快捷键 2">对照</button><button data-mode="side" title="快捷键 3">左右</button><button data-mode="zh" title="快捷键 4">中文</button>
    </div>
    <div class="seg" title="悬停/对应时显示的句子数（不影响翻译）">
      <button data-gran="1">1句</button><button data-gran="2">2句</button><button data-gran="3">3句</button><button data-gran="para">整段</button>
    </div>
    <select id="opt-peek" title="单语模式下如何查看另一种语言（英文模式看中文，中文模式看英文）">
      <option value="popover">悬浮气泡</option><option value="inline">段下展开</option><option value="swap">点击切换</option><option value="off">不提示</option>
    </select>
    <select id="opt-source" title="正文来源：Zotero 自带的结构化文本（可在 PDF 上定位和高亮），或 MinerU 解析结果（行内公式用 LaTeX 排版，可复制）">
      <option value="zotero">来源：Zotero</option><option value="mineru">来源：MinerU</option>
    </select>
    <select id="opt-rich" title="公式与表格：原 PDF 截图，或用 MinerU 解析结果重建（LaTeX 公式可复制，表格可选中）">
      <option value="mineru">公式表格：MinerU</option><option value="pdf">公式表格：原图</option>
    </select>
    <button id="btn-mineru" class="link" hidden title="可选：用 MinerU 解析这篇 PDF，公式按 LaTeX 排版、表格可选中（需要免费的 MinerU API Token）">MinerU 解析…</button>
    <select id="opt-theme" title="页面配色">
      <option value="auto">主题：跟随 Zotero</option><option value="light">主题：浅色</option><option value="sepia">主题：护眼</option><option value="dark">主题：深色</option>
    </select>
    <span class="opt" title="悬停或选中句子时，怎样标出两种语言的对应句">
      <select id="opt-pair"><option value="frame">对应句：线框</option><option value="underline">对应句：下划线</option><option value="fill">对应句：底色</option></select>
      <input type="color" id="opt-pair-color" title="对应句标记的颜色">
      <button id="opt-pair-reset" class="link" title="颜色跟随主题">默认色</button>
    </span>
    <label class="opt"><input type="checkbox" id="opt-auto"> 自动翻译</label>
    <label class="opt" id="opt-hlzh-wrap" title="勾选后，在双语页创建的高亮会把中文译文写进批注，用 Zotero 的“从注释添加笔记”时笔记里中英都有；默认不附"><input type="checkbox" id="opt-hlzh"> 高亮附译文</label>
    <div class="seg"><button id="font-dec" title="缩小字号（快捷键 -）">A−</button><button id="font-inc" title="放大字号（快捷键 +）">A+</button></div>
    <select id="engine" title="翻译引擎"></select>
    <button id="btn-translate" class="primary">翻译全文</button>
    <span id="progress"></span>
    <button id="btn-handoff" title="让你自己打开的 Agent 会话通读全文、统一术语后整篇译完；插件给出提示词并接收结果">交给 Agent…</button>
    <button id="btn-glossary" class="link" title="查看或修改这篇论文的术语表">术语表</button>
    <button id="btn-clear" class="link" title="删除这篇论文的缓存译文（含手动修改的），之后可以用当前引擎重新翻译；有两个来源时可以只清除当前来源">清除译文</button>
    <button id="btn-popout" class="link" title="移到单独的窗口（放在屏幕右半边）；Zotero 窗口按 Win+← 贴到左边，就是左边 PDF、右边双语">新窗口</button>`));
  bar.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => b.addEventListener("click", () => setPrefs({ mode: b.dataset.mode as Mode })));
  bar.querySelectorAll<HTMLElement>("[data-gran]").forEach((b) =>
    b.addEventListener("click", () => {
      const g = b.dataset.gran === "para" ? "para" : (Number(b.dataset.gran) as Granularity);
      setPrefs({ granularity: g }, false);
    }),
  );
  $("#opt-peek").addEventListener("change", (e) => setPrefs({ peek: (e.target as HTMLSelectElement).value as PeekStyle }));
  $("#opt-source").addEventListener("change", (e) =>
    switchSource((e.target as HTMLSelectElement).value as DocSource).catch((err) => toast(`切换来源失败：${err?.message ?? err}`)),
  );
  $("#btn-mineru").addEventListener("click", () => void openMineruDialog(state.host, toast, loadEnrichment));
  $("#opt-theme").addEventListener("change", (e) => setPrefs({ theme: (e.target as HTMLSelectElement).value as Theme }, false));
  $("#opt-pair").addEventListener("change", (e) => setPrefs({ pairStyle: (e.target as HTMLSelectElement).value as PairStyle }, false));
  $("#opt-pair-color").addEventListener("input", (e) => setPrefs({ pairColor: (e.target as HTMLInputElement).value }, false));
  $("#opt-pair-reset").addEventListener("click", () => setPrefs({ pairColor: "" }, false));
  $("#opt-rich").addEventListener("change", (e) => setPrefs({ rich: (e.target as HTMLSelectElement).value as RichStyle }));
  $("#opt-auto").addEventListener("change", (e) => {
    autoPaused = false;
    setPrefs({ autoTranslate: (e.target as HTMLInputElement).checked });
  });
  $("#opt-hlzh").addEventListener("change", (e) => setPrefs({ highlightWithZh: (e.target as HTMLInputElement).checked }, false));
  $("#font-dec").addEventListener("click", () => setPrefs({ fontSize: Math.max(12, state.prefs.fontSize - 1) }));
  $("#font-inc").addEventListener("click", () => setPrefs({ fontSize: Math.min(28, state.prefs.fontSize + 1) }));
  $("#btn-translate").addEventListener("click", () => {
    if (state.progress.running) {
      autoPaused = true;
      autoObserver?.disconnect();
      clearAutoQueue();
      state.host.cancel();
      toast("已停止；自动翻译暂停，点“翻译全文”或重新勾选“自动翻译”恢复");
      return;
    }
    autoPaused = false;
    setupAutoTranslate();
    state.host.translate({ all: true, retryFailed: true }).catch((err) => toast(`翻译失败：${err?.message ?? err}`));
  });
  $("#btn-handoff").addEventListener("click", () => void openHandoff());
  $("#btn-popout").hidden = !state.host.popOut;
  $("#btn-back-pdf").hidden = !state.host.backToPdf;
  $("#btn-back-pdf").addEventListener("click", () => state.host.backToPdf?.());
  $("#btn-outline").addEventListener("click", () => outline?.toggle());
  $("#btn-popout").addEventListener("click", () => void state.host.popOut?.());
  $("#btn-glossary").addEventListener("click", () => void openGlossary());
  $("#btn-clear").addEventListener("click", () => void confirmClear());
  $("#engine").addEventListener("change", (e) => setPrefs({ engineId: (e.target as HTMLSelectElement).value }, false));
}

/** With two sources, ask which translations go; otherwise a plain confirmation. */
async function confirmClear() {
  const clear = async (scope: "source" | "all") => {
    try {
      await state.host.clearTranslations(scope);
      location.reload();
    } catch (err: any) {
      toast(`清除失败：${err?.message ?? err}`);
    }
  };
  if (!state.hasMineru) {
    if (confirm("删除这篇论文的全部译文缓存（包括你手动修改的译文）？删除后可以重新翻译。")) await clear("all");
    return;
  }
  const here = isMineruDoc() ? "MinerU" : "Zotero";
  const back = modal("清除译文");
  const body = back.querySelector(".ho-body")!;
  const p = document.createElement("p");
  p.className = "ho-intro";
  p.textContent = `两个来源各有一份译文，只有文字完全相同的句子共用一条。清除当前来源（${here}）时，这些共用的句子在另一个来源里也会变回未翻译；手动修改过的译文同样会被删除。`;
  const actions = document.createElement("div");
  actions.className = "ho-actions";
  const mk = (text: string, scope: "source" | "all") => {
    const b = document.createElement("button");
    b.textContent = text;
    b.addEventListener("click", () => {
      back.remove();
      void clear(scope);
    });
    return b;
  };
  actions.append(mk(`只清除 ${here} 来源`, "source"), mk("清除两个来源的全部译文", "all"));
  body.append(p, actions);
}

async function fillEngines() {
  const engines = await state.host.getEngines();
  const sel = $("#engine") as HTMLSelectElement;
  sel.replaceChildren(
    ...engines.map((en) => {
      const o = document.createElement("option");
      o.value = en.id;
      o.textContent = en.label + (en.ready ? "" : "（未配置）");
      o.disabled = !en.ready;
      return o;
    }),
  );
  const cur = engines.find((e) => e.id === state.prefs.engineId && e.ready) ?? engines.find((e) => e.ready);
  if (cur) {
    sel.value = cur.id;
    if (cur.id !== state.prefs.engineId) await setPrefs({ engineId: cur.id }, false);
  }
}

// Reading position per paper, so reopening it continues where the reader left off. The host
// keeps it (the privileged reader page has no usable localStorage).
let posTimer: number | undefined;

// Stored as "<block id>@<page>": block ids differ between the Zotero and MinerU texts, so a
// position saved under one source falls back to its page under the other.
function rememberPosition() {
  clearTimeout(posTimer);
  posTimer = window.setTimeout(() => {
    const b = firstVisibleBlock();
    const page = b ? state.blocks.get(b)?.pageRects[0]?.[0] : undefined;
    if (b) state.host.setPosition(page === undefined ? b : `${b}@${page}`).catch(() => {});
  }, 500);
}

async function restorePosition() {
  const pos = await state.host.getPosition().catch(() => null);
  if (!pos) return;
  const at = pos.lastIndexOf("@");
  const b = at < 0 ? pos : pos.slice(0, at);
  const page = at < 0 ? "" : pos.slice(at + 1);
  const target =
    document.querySelector<HTMLElement>(`section.blk[data-b="${CSS.escape(b)}"]`) ??
    (page ? document.querySelector<HTMLElement>(`.page-marker[data-page="${CSS.escape(page)}"]`) : null);
  target?.scrollIntoView({ block: "start" });
}

const MODE_KEYS: Record<string, Mode> = { "1": "en", "2": "interleave", "3": "side", "4": "zh" };

function installShortcuts() {
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t.closest?.("input, textarea, select, [contenteditable]")) return;
    const mode = MODE_KEYS[e.key];
    if (mode) setPrefs({ mode });
    else if (e.key === "+" || e.key === "=") setPrefs({ fontSize: Math.min(28, state.prefs.fontSize + 1) });
    else if (e.key === "-") setPrefs({ fontSize: Math.max(12, state.prefs.fontSize - 1) });
    else if (e.key === "t" || e.key === "T") outline?.toggle();
    else if (e.key === "b" || e.key === "B") outline?.toggleHere();
    else return;
    e.preventDefault();
  });
}

async function main() {
  const host = await waitForHost();
  // Until the document arrives, show what the host is doing (e.g. Zotero parsing the PDF).
  const unsubLoading = host.subscribe((ev) => {
    const box = document.querySelector(".loading-doc");
    if (box && ev.type === "progress" && ev.progress.message) box.textContent = ev.progress.message;
  });
  // Text first; MinerU enrichment (reads and hashes the PDF) and engine detection fill in later.
  const [doc, tr, prefs] = await Promise.all([host.getDocument(), host.getTranslations(), host.getPrefs()]);
  state = {
    host,
    doc,
    blocks: new Map(doc.blocks.map((b) => [b.id, b])),
    tr,
    prefs: { ...DEFAULT_PREFS, ...prefs },
    progress: { running: false, done: 0, total: 0, failed: 0 },
    enrich: null,
    sdtEnrich: null,
    hasMineru: false,
    highlights: [],
  };
  unsubLoading();
  buildToolbar();
  $("#title").textContent = doc.title ?? "";
  document.title = `${doc.title ?? ""} · 双语阅读`;
  state.enrich = enrichmentFor(doc);
  state.hasMineru = doc.parser.kind === "mineru";
  renderAll();
  await restorePosition();
  window.addEventListener("scroll", rememberPosition, { passive: true });
  installShortcuts();
  void fillEngines().catch((err) => toast(`检测翻译引擎失败：${err?.message ?? err}`));
  loadEnrichment();
  if (host.capabilities.highlights) {
    void host
      .getHighlights()
      .then((h) => {
        state.highlights = h;
        applyHighlights();
      })
      .catch(() => {});
  }
  installInteractions({
    host,
    root: $("#doc"),
    blocks: state.blocks,
    getTranslations: () => state.tr,
    getMode: () => state.prefs.mode,
    getGranularity: () => state.prefs.granularity,
    getPeek: () => state.prefs.peek,
    getHighlights: () => state.highlights,
    getHighlightWithZh: () => state.prefs.highlightWithZh,
    // MinerU sentences are highlighted through the Zotero text they were aligned with.
    canHighlight: () => host.capabilities.highlights,
    toast,
  });
  finder = installSearch({ blocks: () => state.doc.blocks, getTranslations: () => state.tr });
  outline = installOutline({
    host,
    getDoc: () => state.doc,
    getTranslations: () => state.tr,
    currentBlock: firstVisibleBlock,
    getHighlights: () => state.highlights,
    openHighlight: (id) => {
      const h = state.highlights.find((x) => x.id === id);
      const span = h && h.unitIds.map((u) => document.querySelector<HTMLElement>(`.s.marked[data-u="${CSS.escape(u)}"]`)).find(Boolean);
      span?.click();
    },
    isOpen: () => state.prefs.outline,
    getTab: () => state.prefs.outlineTab ?? "toc",
    setOpen: (open: boolean, tab?: OutlineTab) => {
      void setPrefs(tab ? { outline: open, outlineTab: tab } : { outline: open }, false);
      outline?.syncOpen();
    },
    toast,
  });
  outline.refresh();
  const blockAction = installBlockAction({
    root: $("#doc"),
    blocks: state.blocks,
    getTranslations: () => state.tr,
    failed: failedUnits,
    translate: (blockId, retranslate) => host.translate({ blockIds: [blockId], retranslate, retryFailed: true }),
    isRunning: () => state.progress.running,
    toast,
  });
  const unsubscribe = host.subscribe((ev) => {
    if (ev.type === "translations") {
      for (const id of Object.keys(ev.units)) failedUnits.delete(id);
      for (const [id, why] of Object.entries(ev.failed ?? {})) failedUnits.set(id, why);
      applyTranslations(ev.units);
      blockAction.refresh([...Object.keys(ev.units), ...Object.keys(ev.failed ?? {})]);
    }
    else if (ev.type === "highlights") {
      state.highlights = ev.highlights;
      applyHighlights();
    }
    else if (ev.type === "progress") {
      state.progress = ev.progress;
      updateProgressText();
      if (!ev.progress.running) blockAction.refresh([], false);
    }
  });
  void initHandoff({ host, toast, onChange: updateProgressText }).catch(() => {});
  // The host outlives this page if the iframe reloads; do not leave it calling a dead document.
  window.addEventListener("unload", () => unsubscribe(), { once: true });
  document.body.classList.add("ready");
}

main().catch((err) => {
  const pre = document.createElement("pre");
  pre.className = "fatal";
  pre.textContent = `双语阅读加载失败：${err?.message ?? err}\n${err?.stack ?? ""}`;
  document.body.replaceChildren(pre);
});
