// Hover sync, peek popover and selection-to-sentence mapping.

import { clearPairFrame, drawPairFrame } from "./pair-frame";
import { blockIdOf, groupUnits } from "../core/groups";
import type { Granularity, HighlightView, Mode, PeekStyle, ZbrHost } from "../core/host-api";
import type { Block } from "../core/model";
import { translationFor, type Translations } from "./render";
import { setRich } from "./richtext";
import { spansOf } from "./spans";

export interface InteractCtx {
  host: ZbrHost;
  root: HTMLElement;
  blocks: Map<string, Block>;
  getTranslations(): Translations;
  getMode(): Mode;
  getGranularity(): Granularity;
  getPeek(): PeekStyle;
  getHighlights(): HighlightView[];
  /** Whether new highlights carry the Chinese translation in their comment. */
  getHighlightWithZh(): boolean;
  /** Highlights need Zotero's character geometry, which the MinerU source does not have. */
  canHighlight(): boolean;
  /** Add or remove the bookmark of a paragraph. */
  toggleBookmark?(blockId: string): void;
  isBookmarked?(blockId: string): boolean;
  toast(msg: string): void;
}

const HIGHLIGHT_COLORS = ["#ffd400", "#ff6666", "#5fb236", "#2ea8e5", "#a28ae5"];

let popover: HTMLDivElement | null = null;

function hidePopover() {
  popover?.remove();
  popover = null;
}

/** Whether any of the units comes from text with inline LaTeX. */
function hasMath(ctx: InteractCtx, ids: string[]): boolean {
  return ids.some((id) => ctx.blocks.get(blockIdOf(id))?.inlineMath);
}

function showPopover(ctx: InteractCtx, anchor: DOMRect, title: string, body: string[], actions?: HTMLElement, math = false) {
  hidePopover();
  const pop = document.createElement("div");
  pop.className = "peek";
  const h = document.createElement("div");
  h.className = "peek-title";
  h.textContent = title;
  pop.append(h);
  for (const para of body) {
    const p = document.createElement("p");
    setRich(p, para, math);
    pop.append(p);
  }
  if (actions) pop.append(actions);
  document.body.append(pop);
  const w = Math.min(560, window.innerWidth - 24);
  pop.style.maxWidth = `${w}px`;
  const r = pop.getBoundingClientRect();
  let top = anchor.top - r.height - 8;
  if (top < 8) top = anchor.bottom + 8;
  const left = Math.min(window.innerWidth - r.width - 12, Math.max(12, anchor.left + anchor.width / 2 - r.width / 2));
  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;
  popover = pop;
}

function unitElements(_root: HTMLElement, ids: string[]): HTMLElement[] {
  return ids.flatMap(spansOf);
}

function englishOf(ctx: InteractCtx, ids: string[]): string[] {
  return joinByBlock(ctx, ids, (b, id) => b.sentences.find((s) => s.id === id)?.text ?? "", " ");
}

function chineseOf(ctx: InteractCtx, ids: string[]): string[] {
  const tr = ctx.getTranslations();
  return joinByBlock(ctx, ids, (b, id) => {
    const s = b.sentences.find((x) => x.id === id);
    return s ? (translationFor(s, tr) ?? "（未翻译）") : "";
  }, "");
}

/** Join unit texts, keeping one paragraph per block so non-contiguous selections stay separate. */
function joinByBlock(ctx: InteractCtx, ids: string[], get: (b: Block, id: string) => string, sep: string): string[] {
  const out: string[] = [];
  let lastBlock = "";
  for (const id of ids) {
    const bid = blockIdOf(id);
    const b = ctx.blocks.get(bid);
    if (!b) continue;
    const t = get(b, id);
    if (bid === lastBlock) out[out.length - 1] += sep + t;
    else out.push(t);
    lastBlock = bid;
  }
  return out;
}

/** Unit ids whose sentence span is actually covered by the selection (not just touched at an edge). */
export function unitsInSelection(root: HTMLElement, sel: Selection | null): string[] {
  if (!sel || sel.isCollapsed || !sel.rangeCount) return [];
  const range = sel.getRangeAt(0);
  const ids: string[] = [];
  // Only spans under the range's common ancestor can intersect it; usually one paragraph.
  const common = range.commonAncestorContainer;
  const scope = common.nodeType === Node.ELEMENT_NODE ? (common as HTMLElement) : common.parentElement;
  const within = scope && root.contains(scope) ? scope : root;
  const candidates = within.matches?.(".s[data-u]") ? [within] : Array.from(within.querySelectorAll<HTMLElement>(".s[data-u]"));
  for (const span of candidates) {
    if (!range.intersectsNode(span)) continue;
    const r = document.createRange();
    r.selectNodeContents(span);
    // Overlap must contain at least one non-space character.
    const startCmp = range.compareBoundaryPoints(Range.START_TO_END, r); // range.start vs span.end
    const endCmp = range.compareBoundaryPoints(Range.END_TO_START, r); // range.end vs span.start
    if (startCmp <= 0 || endCmp >= 0) continue;
    const overlap = range.cloneRange();
    if (range.compareBoundaryPoints(Range.START_TO_START, r) < 0) overlap.setStart(r.startContainer, r.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, r) > 0) overlap.setEnd(r.endContainer, r.endOffset);
    if (!overlap.toString().trim()) continue;
    if (!ids.includes(span.dataset.u!)) ids.push(span.dataset.u!);
  }
  return ids;
}

/** Comment for a new highlight: the user's note, then the Chinese translation if wanted and available. */
function highlightComment(ctx: InteractCtx, ids: string[], note: string): string {
  const parts = note.trim() ? [note.trim()] : [];
  if (ctx.getHighlightWithZh()) {
    const tr = ctx.getTranslations();
    const zh = ids.map((id) => {
      const s = ctx.blocks.get(blockIdOf(id))?.sentences.find((x) => x.id === id);
      return s ? translationFor(s, tr) : undefined;
    });
    if (zh.every((z) => z)) parts.push(`【译】${zh.join("")}`);
  }
  return parts.join("\n");
}

/** Replace an action bar with a small comment editor. */
function editor(bar: HTMLElement, initial: string, save: (text: string) => void) {
  const box = document.createElement("div");
  box.className = "peek-editor";
  const ta = document.createElement("textarea");
  ta.value = initial;
  ta.rows = 3;
  ta.placeholder = "批注（保存在这条高亮的 Zotero 注释里）";
  const ok = document.createElement("button");
  ok.textContent = "保存";
  ok.addEventListener("click", () => save(ta.value));
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save(ta.value);
    e.stopPropagation();
  });
  box.append(ta, ok);
  bar.replaceWith(box);
  ta.focus();
}

function actionBar(ctx: InteractCtx, ids: string[]): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "peek-actions";
  const btn = (label: string, fn: () => void, title?: string) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => {
      fn();
    });
    bar.append(b);
    return b;
  };
  btn("复制英文", () => navigator.clipboard.writeText(englishOf(ctx, ids).join("\n\n")).then(() => ctx.toast("已复制英文")));
  btn("复制中文", () => navigator.clipboard.writeText(chineseOf(ctx, ids).join("\n\n")).then(() => ctx.toast("已复制中文")));
  btn("重新翻译", () => retranslate(ctx, ids), "用当前引擎重新翻译所选句子所在的段落，覆盖已有译文");
  if (ids.length === 1) {
    const current = chineseOf(ctx, ids).join("").replace(/^（未翻译）$/, "");
    btn("修改译文…", () => editor(bar, current, (zh) => void saveTranslation(ctx, ids[0], zh)), "手动改这句的中文；Ctrl+Enter 保存");
  }
  if (ctx.host.capabilities.openInPdf) {
    btn("在 PDF 中定位", () => ctx.host.openInPdf({ blockId: blockIdOf(ids[0]), unitIds: ids }));
  }
  if (ctx.canHighlight()) {
    const create = (color: string, note = "") => createHighlight(ctx, ids, color, note);
    for (const c of HIGHLIGHT_COLORS) {
      const b = btn("", () => void create(c), ctx.getHighlightWithZh() ? "添加高亮（Zotero 注释，批注里附中文译文）" : "添加高亮（Zotero 注释，PDF 阅读器里同样显示）");
      b.className = "swatch";
      b.style.background = c;
    }
    btn("高亮并批注…", () => editor(bar, "", (note) => create(HIGHLIGHT_COLORS[0], note)), "写一条批注，和高亮一起保存为 Zotero 注释");
  }
  return bar;
}

function createHighlight(ctx: InteractCtx, ids: string[], color: string, note = "") {
  return ctx.host
    .createHighlight({ unitIds: ids, color, comment: highlightComment(ctx, ids, note) })
    .then(() => {
      hidePopover();
      window.getSelection()?.removeAllRanges();
      ctx.toast("已添加高亮（Zotero 注释，PDF 阅读器里也能看到）");
    })
    .catch((e) => ctx.toast(`高亮失败：${e?.message ?? e}`));
}

function saveTranslation(ctx: InteractCtx, id: string, zh: string) {
  return ctx.host
    .editTranslation(id, zh)
    .then(() => {
      hidePopover();
      ctx.toast("已保存你的译文（之后不会被自动翻译覆盖）");
    })
    .catch((e) => ctx.toast(`保存失败：${e?.message ?? e}`));
}

function retranslate(ctx: InteractCtx, ids: string[]) {
  const blocks = [...new Set(ids.map(blockIdOf))];
  ctx.host
    .translate({ blockIds: blocks, retranslate: true })
    .then(() => ctx.toast(`已提交重新翻译（${blocks.length} 段）`))
    .catch((e) => ctx.toast(`重新翻译失败：${e?.message ?? e}`));
}

function copyText(ctx: InteractCtx, text: string, what: string) {
  return navigator.clipboard.writeText(text).then(
    () => ctx.toast(`已复制${what}`),
    (e) => ctx.toast(`复制失败：${e?.message ?? e}`),
  );
}

/** English and Chinese of each paragraph, one after the other. */
function bilingualOf(ctx: InteractCtx, ids: string[]): string {
  const en = englishOf(ctx, ids);
  const zh = chineseOf(ctx, ids);
  return en.map((t, i) => `${t}\n${zh[i] ?? ""}`).join("\n\n");
}

let menu: HTMLDivElement | null = null;
let menuCleanup: (() => void) | null = null;

function hideMenu() {
  menuCleanup?.();
  menuCleanup = null;
  menu?.remove();
  menu = null;
}

interface MenuTarget {
  ids: string[];
  /** Text selected in the page, when the menu was opened over it. */
  selection: string;
  highlight?: HighlightView;
  /** The sentence that was clicked: editors open next to it. */
  span?: HTMLElement;
}

/**
 * Right-click menu over sentences: what the selection bar offers, without selecting first. It
 * acts on the selected sentences when opened over the selection, otherwise on the sentence under
 * the pointer (as many sentences as the hover setting groups).
 */
function showMenu(ctx: InteractCtx, x: number, y: number, t: MenuTarget, onClose: () => void) {
  hideMenu();
  hidePopover();
  const m = document.createElement("div");
  m.className = "ctx-menu";
  m.addEventListener("mousedown", (e) => e.preventDefault());
  m.addEventListener("contextmenu", (e) => e.preventDefault());
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    hideMenu();
    onClose();
  };
  const item = (label: string, fn: () => void, hint = "") => {
    const b = document.createElement("button");
    b.className = "ctx-item";
    b.append(label);
    if (hint) {
      const k = document.createElement("span");
      k.className = "ctx-hint";
      k.textContent = hint;
      b.append(k);
    }
    // The action first: an editor it opens keeps the menu's selection state when the menu goes.
    b.addEventListener("click", () => {
      fn();
      close();
    });
    m.append(b);
  };
  const sep = () => {
    const last = m.lastElementChild;
    if (last && !last.classList.contains("ctx-sep")) {
      const d = document.createElement("div");
      d.className = "ctx-sep";
      m.append(d);
    }
  };
  const swatches = (label: string, current: string | undefined, fn: (c: string) => void) => {
    const row = document.createElement("div");
    row.className = "ctx-swatches";
    const l = document.createElement("span");
    l.textContent = label;
    row.append(l);
    for (const c of HIGHLIGHT_COLORS) {
      const b = document.createElement("button");
      b.className = "swatch" + (c.toLowerCase() === current?.toLowerCase() ? " on" : "");
      b.style.background = c;
      b.addEventListener("click", () => {
        fn(c);
        close();
      });
      row.append(b);
    }
    m.append(row);
  };
  // An editor in a card next to the sentence, as from the selection bar.
  const editAt = (title: string, initial: string, save: (text: string) => void) => {
    const bar = document.createElement("div");
    showPopover(ctx, t.span?.getBoundingClientRect() ?? new DOMRect(x, y, 0, 0), title, [], bar);
    editor(bar, initial, save);
  };
  const fail = (e: any) => ctx.toast(`操作失败：${e?.message ?? e}`);
  const { ids } = t;
  const these = ids.length === 1 ? "这句" : `这 ${ids.length} 句`;

  if (t.selection) item("复制", () => void copyText(ctx, t.selection, "选中的文字"), "Ctrl+C");
  item("复制英文", () => void copyText(ctx, englishOf(ctx, ids).join("\n\n"), "英文"));
  item("复制中文", () => void copyText(ctx, chineseOf(ctx, ids).join("\n\n"), "中文"));
  item("复制中英对照", () => void copyText(ctx, bilingualOf(ctx, ids), "中英对照"));
  sep();
  const h = t.highlight;
  if (h) {
    item(h.comment ? "编辑批注…" : "添加批注…", () =>
      editAt("高亮批注", h.comment ?? "", (comment) =>
        ctx.host.updateHighlight({ id: h.id, comment }).then(() => {
          hidePopover();
          ctx.toast("批注已保存");
        }, fail),
      ),
    );
    swatches("颜色", h.color, (c) => void ctx.host.updateHighlight({ id: h.id, color: c }).catch(fail));
    item("删除高亮", () => {
      if (!window.confirm("删除这条高亮及其批注？（Zotero 的 PDF 阅读器里也会一并删除）")) return;
      ctx.host.deleteHighlight(h.id).then(() => ctx.toast("已删除高亮"), fail);
    });
    if (ctx.host.capabilities.openInPdf) item("在 PDF 中查看这条高亮", () => void ctx.host.openHighlight(h.id).catch(fail));
  } else if (ctx.canHighlight()) {
    swatches(`高亮${these}`, undefined, (c) => void createHighlight(ctx, ids, c));
    item("高亮并批注…", () => editAt(`高亮${these}并批注`, "", (note) => void createHighlight(ctx, ids, HIGHLIGHT_COLORS[0], note)));
  }
  sep();
  if (ctx.host.capabilities.openInPdf && !h) item("在 PDF 中定位", () => void ctx.host.openInPdf({ blockId: blockIdOf(ids[0]), unitIds: ids }));
  if (ids.length === 1) {
    const current = chineseOf(ctx, ids).join("").replace(/^（未翻译）$/, "");
    item("修改译文…", () => editAt("修改译文", current, (zh) => void saveTranslation(ctx, ids[0], zh)));
  }
  item("重新翻译这段", () => retranslate(ctx, ids));
  if (ctx.toggleBookmark) {
    const bid = blockIdOf(ids[0]);
    item(ctx.isBookmarked?.(bid) ? "删除这段的书签" : "给这段加书签", () => ctx.toggleBookmark!(bid));
  }
  if (m.lastElementChild?.classList.contains("ctx-sep")) m.lastElementChild.remove();

  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  m.style.top = `${Math.max(4, y + r.height > window.innerHeight - 4 ? y - r.height : y)}px`;
  menu = m;
  // Closed by a click elsewhere, Escape, scrolling or leaving the window.
  const away = (e: Event) => {
    if (!m.contains(e.target as Node)) close();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    close();
  };
  document.addEventListener("mousedown", away, true);
  document.addEventListener("keydown", key, true);
  window.addEventListener("scroll", close, { capture: true, passive: true });
  window.addEventListener("blur", close);
  menuCleanup = () => {
    document.removeEventListener("mousedown", away, true);
    document.removeEventListener("keydown", key, true);
    window.removeEventListener("scroll", close, true);
    window.removeEventListener("blur", close);
  };
}

/** Actions for an existing highlight: edit its comment, recolor, show it in the PDF, delete. */
function highlightBar(ctx: InteractCtx, h: HighlightView): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "peek-actions";
  const btn = (label: string, fn: () => void, title?: string) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", fn);
    bar.append(b);
    return b;
  };
  const fail = (e: any) => ctx.toast(`操作失败：${e?.message ?? e}`);
  btn("编辑批注", () =>
    editor(bar, h.comment ?? "", (comment) =>
      ctx.host.updateHighlight({ id: h.id, comment }).then(() => {
        hidePopover();
        ctx.toast("批注已保存");
      }, fail),
    ),
  );
  btn("在 PDF 中查看", () => ctx.host.openHighlight(h.id).catch(fail), "在 Zotero 阅读器中打开并选中这条高亮");
  for (const c of HIGHLIGHT_COLORS) {
    const b = btn("", () => ctx.host.updateHighlight({ id: h.id, color: c }).then(hidePopover, fail), "改为这个颜色");
    b.className = "swatch" + (c.toLowerCase() === h.color?.toLowerCase() ? " on" : "");
    b.style.background = c;
  }
  btn("删除高亮", () => {
    if (!window.confirm("删除这条高亮及其批注？（Zotero 的 PDF 阅读器里也会一并删除）")) return;
    ctx.host.deleteHighlight(h.id).then(() => {
      hidePopover();
      ctx.toast("已删除高亮");
    }, fail);
  });
  return bar;
}

/** Expanded box under the paragraph that shows the other language for the hovered group. */
function showInline(section: HTMLElement, title: string, body: string[], math: boolean) {
  let box = section.querySelector<HTMLElement>(":scope > .peek-inline");
  if (!box) {
    box = document.createElement("div");
    box.className = "peek-inline";
    section.append(box);
  }
  const h = document.createElement("div");
  h.className = "peek-title";
  h.textContent = title;
  box.replaceChildren(
    h,
    ...body.map((t) => {
      const p = document.createElement("p");
      setRich(p, t, math);
      return p;
    }),
  );
}

function hideInline(root: HTMLElement) {
  root.querySelectorAll(".peek-inline").forEach((b) => b.remove());
}

/** Click-to-swap: replace each sentence of the group with its counterpart, click again to restore. */
function toggleSwap(ctx: InteractCtx, ids: string[]) {
  const els = unitElements(ctx.root, ids);
  const restore = els.some((e) => e.classList.contains("swapped"));
  const tr = ctx.getTranslations();
  for (const e of els) {
    if (restore) {
      if (e.dataset.orig !== undefined) setRich(e, e.dataset.orig, ctx.blocks.get(blockIdOf(e.dataset.u!))?.inlineMath);
      delete e.dataset.orig;
      e.classList.remove("swapped");
      continue;
    }
    const id = e.dataset.u!;
    const s = ctx.blocks.get(blockIdOf(id))?.sentences.find((x) => x.id === id);
    if (!s) continue;
    const inZh = !!e.closest(".zh");
    // Chinese spans carry no separators, so English swapped into them needs its own trailing space.
    const other = inZh ? `${s.text} ` : translationFor(s, tr);
    if (other === undefined) continue;
    const block = ctx.blocks.get(blockIdOf(id))!;
    e.dataset.orig = inZh ? (translationFor(s, tr) ?? s.text) : s.text;
    setRich(e, other, block.inlineMath);
    e.classList.add("swapped");
  }
}

export function installInteractions(ctx: InteractCtx) {
  const { root } = ctx;
  let hovered: string[] = [];
  let selectionActive = false;
  let peekTimer: number | undefined;

  const setHover = (ids: string[]) => {
    for (const e of unitElements(root, hovered)) e.classList.remove("hl");
    hovered = ids;
    const els = unitElements(root, hovered);
    for (const e of els) e.classList.add("hl");
    // Frame style: one outline per paragraph and language, drawn over the text.
    if ((document.documentElement.dataset.pair ?? "frame") === "frame") drawPairFrame(els);
    else clearPairFrame();
  };
  const singleLang = () => ctx.getMode() === "en" || ctx.getMode() === "zh";
  const clearPeek = () => {
    clearTimeout(peekTimer);
    hidePopover();
    hideInline(root);
  };

  root.addEventListener("mouseover", (e) => {
    if (selectionActive) return;
    const span = (e.target as HTMLElement).closest?.(".s[data-u]") as HTMLElement | null;
    if (!span) return;
    const id = span.dataset.u!;
    const block = ctx.blocks.get(blockIdOf(id));
    if (!block) return;
    const ids = groupUnits(block, id, ctx.getGranularity());
    // Same sentence and still marked; after a re-render the new elements carry no mark yet.
    if (ids.join() === hovered.join() && span.classList.contains("hl")) return;
    setHover(ids);
    const peek = ctx.getPeek();
    clearTimeout(peekTimer);
    if (!singleLang() || peek === "off" || peek === "swap") return;
    if (span.classList.contains("swapped")) return;
    const inZh = !!span.closest(".zh");
    const title = inZh ? "英文原文" : "中文译文";
    const body = inZh ? englishOf(ctx, ids) : chineseOf(ctx, ids);
    // Short delay so sweeping the pointer across text does not flash bubbles.
    peekTimer = window.setTimeout(() => {
      if (peek === "popover") {
        const anchor = groupRect(unitElements(root, ids).filter((x) => x.closest(inZh ? ".zh" : ".en")));
        showPopover(ctx, anchor ?? span.getBoundingClientRect(), title, body, undefined, hasMath(ctx, ids));
      } else {
        hideInline(root);
        const section = span.closest<HTMLElement>("section.blk");
        if (section) showInline(section, title, body, hasMath(ctx, ids));
      }
    }, peek === "popover" ? 180 : 260);
  });
  root.addEventListener("mouseout", (e) => {
    if (selectionActive) return;
    const rel = e.relatedTarget as HTMLElement | null;
    if (rel?.closest?.(".s[data-u]")) return;
    // Inline boxes stay while the pointer is inside the same paragraph (including the box itself).
    if (ctx.getPeek() === "inline" && rel && (e.target as HTMLElement).closest("section.blk")?.contains(rel)) return;
    setHover([]);
    clearPeek();
  });
  root.addEventListener("click", (e) => {
    if (!window.getSelection()?.isCollapsed) return;
    const span = (e.target as HTMLElement).closest?.(".s[data-u]") as HTMLElement | null;
    if (!span) return;
    if (ctx.getPeek() !== "swap" || !singleLang()) {
      const h = span.classList.contains("marked") && ctx.getHighlights().find((x) => x.unitIds.includes(span.dataset.u!));
      if (h) {
        clearPeek();
        selectionActive = true;
        showPopover(ctx, span.getBoundingClientRect(), "高亮批注", [h.comment || "（无批注）"], highlightBar(ctx, h));
      }
      return;
    }
    const id = span.dataset.u!;
    const block = ctx.blocks.get(blockIdOf(id));
    if (block) toggleSwap(ctx, groupUnits(block, id, ctx.getGranularity()));
  });

  root.addEventListener("contextmenu", (e) => {
    const span = (e.target as HTMLElement).closest?.(".s[data-u]") as HTMLElement | null;
    const sel = window.getSelection();
    const selected = unitsInSelection(root, sel);
    const overSelection = !!span && selected.includes(span.dataset.u!);
    // Outside sentences (figures, formulas) and with nothing selected there is no menu.
    if (!span && !selected.length) return;
    e.preventDefault();
    let ids = selected;
    if (span && !overSelection) {
      const block = ctx.blocks.get(blockIdOf(span.dataset.u!));
      if (!block) return;
      ids = groupUnits(block, span.dataset.u!, ctx.getGranularity());
    }
    const highlight =
      span && !overSelection && span.classList.contains("marked") ? ctx.getHighlights().find((x) => x.unitIds.includes(span.dataset.u!)) : undefined;
    clearPeek();
    selectionActive = true;
    setHover(ids);
    const selection = !span || overSelection ? (sel?.toString().trim() ?? "") : "";
    showMenu(ctx, e.clientX, e.clientY, { ids, selection, highlight, span: span ?? undefined }, () => {
      selectionActive = !!popover || unitsInSelection(root, window.getSelection()).length > 0;
      if (!selectionActive && !popover) setHover([]);
    });
  });

  document.addEventListener("mouseup", (e) => {
    // Only the left button selects; the right one opens the menu above.
    if (e.button !== 0) return;
    if (popover?.contains(e.target as Node) || menu?.contains(e.target as Node)) return;
    // A plain click on a highlighted sentence opens its card (click handler); keep it open.
    if ((e.target as HTMLElement).closest?.(".s.marked") && window.getSelection()?.isCollapsed) return;
    setTimeout(() => {
      const sel = window.getSelection();
      const ids = unitsInSelection(root, sel);
      if (!ids.length) {
        if (selectionActive) {
          selectionActive = false;
          setHover([]);
          hidePopover();
        }
        return;
      }
      selectionActive = true;
      clearPeek();
      setHover(ids);
      const range = sel!.getRangeAt(0);
      const startNode = range.startContainer;
      const startEl = (startNode.nodeType === Node.ELEMENT_NODE ? startNode : startNode.parentElement) as HTMLElement | null;
      const inZh = !!startEl?.closest(".zh");
      const title = inZh ? `对应英文（${ids.length} 句）` : `对应中文（${ids.length} 句）`;
      showPopover(ctx, range.getBoundingClientRect(), title, inZh ? englishOf(ctx, ids) : chineseOf(ctx, ids), actionBar(ctx, ids), hasMath(ctx, ids));
    }, 0);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      selectionActive = false;
      window.getSelection()?.removeAllRanges();
      setHover([]);
      clearPeek();
    }
  });
  window.addEventListener("scroll", () => {
    if (!selectionActive) hidePopover();
  }, { passive: true });
}

function groupRect(els: HTMLElement[]): DOMRect | null {
  if (!els.length) return null;
  const rs = els.map((e) => e.getBoundingClientRect());
  const left = Math.min(...rs.map((r) => r.left));
  const top = Math.min(...rs.map((r) => r.top));
  const right = Math.max(...rs.map((r) => r.right));
  const bottom = Math.max(...rs.map((r) => r.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}
