import type { Mode, UnitTranslation } from "../core/host-api";
import type { Block, Sentence } from "../core/model";
import { CROP_SCALE, cropRect } from "./figures";
import { setRich } from "./richtext";

export type Translations = Record<string, UnitTranslation>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Append text [start,end) of the block with inline styles from its segments. */
function appendStyled(parent: HTMLElement, block: Block, start: number, end: number) {
  let pos = start;
  for (const seg of block.segments) {
    const a = Math.max(start, seg.start);
    const b = Math.min(end, seg.start + seg.length);
    if (b <= a) continue;
    if (a > pos) parent.append(block.text.slice(pos, a));
    const t = block.text.slice(a, b);
    const st = seg.style;
    if (st && (st.italic || st.bold || st.sub || st.sup || st.monospace)) {
      let node: HTMLElement = el(st.sub ? "sub" : st.sup ? "sup" : "span");
      if (st.italic) node.style.fontStyle = "italic";
      if (st.bold) node.style.fontWeight = "600";
      if (st.monospace) node.style.fontFamily = "monospace";
      node.textContent = t;
      parent.append(node);
    } else {
      parent.append(t);
    }
    pos = b;
  }
  if (pos < end) parent.append(block.text.slice(pos, end));
}

export function renderEnglish(block: Block): HTMLElement {
  const p = el(block.kind === "heading" ? (`h${Math.min(6, (block.level ?? 2) + 1)}` as "h2") : "p", "en");
  if (!block.sentences.length) {
    if (block.inlineMath) setRich(p, block.text, true);
    else appendStyled(p, block, 0, block.text.length);
    return p;
  }
  let pos = 0;
  for (const s of block.sentences) {
    if (s.start > pos) appendStyled(p, block, pos, s.start);
    const span = el("span", "s");
    span.dataset.u = s.id;
    if (block.inlineMath) setRich(span, s.text, true);
    else appendStyled(span, block, s.start, s.end);
    p.append(span);
    pos = s.end;
  }
  if (pos < block.text.length) appendStyled(p, block, pos, block.text.length);
  return p;
}

export function translationFor(s: Sentence, tr: Translations): string | undefined {
  const t = tr[s.id];
  return t && t.srcHash === s.hash ? t.zh : undefined;
}

export function isBlockTranslated(block: Block, tr: Translations): boolean {
  return block.sentences.length > 0 && block.sentences.every((s) => translationFor(s, tr) !== undefined);
}

export function renderChinese(block: Block, tr: Translations): HTMLElement {
  const p = el(block.kind === "heading" ? (`h${Math.min(6, (block.level ?? 2) + 1)}` as "h2") : "p", "zh");
  for (const s of block.sentences) {
    const zh = translationFor(s, tr);
    const span = el("span", zh ? "s" : "s pending");
    span.dataset.u = s.id;
    setRich(span, zh ?? s.text, block.inlineMath);
    p.append(span);
  }
  return p;
}

/** Render one block for a mode. Figures are filled later by figures.ts. */
export function renderBlock(block: Block, mode: Mode, tr: Translations): HTMLElement {
  const wrap = el("section", `blk k-${block.kind}${block.role ? " r-" + block.role : ""}`);
  wrap.dataset.b = block.id;
  if (block.kind === "image" || block.kind === "math" || block.kind === "table") {
    const fig = el("figure", "fig");
    fig.dataset.b = block.id;
    // Reserve the crop's size up front so lazy rendering does not shift the scroll position.
    const crop = cropRect(block);
    if (crop && block.kind !== "math") {
      const [x1, y1, x2, y2] = crop.rect;
      fig.style.setProperty("--fw", `${Math.round((x2 - x1) * CROP_SCALE)}px`);
      fig.style.setProperty("--ar", `${(x2 - x1).toFixed(1)} / ${(y2 - y1).toFixed(1)}`);
      fig.classList.add("sized");
    }
    wrap.append(fig);
    return wrap;
  }
  if (!block.translatable) {
    wrap.append(renderEnglish(block));
    return wrap;
  }
  const done = isBlockTranslated(block, tr);
  wrap.classList.toggle("done", done);
  switch (mode) {
    case "en":
      wrap.append(renderEnglish(block));
      break;
    case "zh":
      wrap.append(renderChinese(block, tr));
      break;
    case "interleave":
      wrap.append(renderEnglish(block), renderChinese(block, tr));
      break;
    case "side": {
      const row = el("div", "side");
      row.append(renderEnglish(block), renderChinese(block, tr));
      wrap.append(row);
      break;
    }
  }
  return wrap;
}
