// Hover sync, peek popover and selection-to-sentence mapping.

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
  btn("重新翻译", () => {
    const blocks = [...new Set(ids.map(blockIdOf))];
    ctx.host
      .translate({ blockIds: blocks, retranslate: true })
      .then(() => ctx.toast(`已提交重新翻译（${blocks.length} 段）`))
      .catch((e) => ctx.toast(`重新翻译失败：${e?.message ?? e}`));
  }, "用当前引擎重新翻译所选句子所在的段落，覆盖已有译文");
  if (ids.length === 1) {
    const current = chineseOf(ctx, ids).join("").replace(/^（未翻译）$/, "");
    btn("修改译文…", () =>
      editor(bar, current, (zh) =>
        ctx.host
          .editTranslation(ids[0], zh)
          .then(() => {
            hidePopover();
            ctx.toast("已保存你的译文（之后不会被自动翻译覆盖）");
          })
          .catch((e) => ctx.toast(`保存失败：${e?.message ?? e}`)),
      ), "手动改这句的中文；Ctrl+Enter 保存");
  }
  if (ctx.host.capabilities.openInPdf) {
    btn("在 PDF 中定位", () => ctx.host.openInPdf({ blockId: blockIdOf(ids[0]), unitIds: ids }));
  }
  if (ctx.canHighlight()) {
    const create = (color: string, note = "") =>
      ctx.host
        .createHighlight({ unitIds: ids, color, comment: highlightComment(ctx, ids, note) })
        .then(() => {
          hidePopover();
          window.getSelection()?.removeAllRanges();
          ctx.toast("已添加高亮（Zotero 注释，PDF 阅读器里也能看到）");
        })
        .catch((e) => ctx.toast(`高亮失败：${e?.message ?? e}`));
    for (const c of HIGHLIGHT_COLORS) {
      const b = btn("", () => void create(c), ctx.getHighlightWithZh() ? "添加高亮（Zotero 注释，批注里附中文译文）" : "添加高亮（Zotero 注释，PDF 阅读器里同样显示）");
      b.className = "swatch";
      b.style.background = c;
    }
    btn("高亮并批注…", () => editor(bar, "", (note) => create(HIGHLIGHT_COLORS[0], note)), "写一条批注，和高亮一起保存为 Zotero 注释");
  }
  return bar;
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
    for (const e of unitElements(root, hovered)) e.classList.add("hl");
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

  document.addEventListener("mouseup", (e) => {
    if (popover?.contains(e.target as Node)) return;
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
