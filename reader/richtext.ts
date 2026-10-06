// Text with inline LaTeX (`$...$`, MinerU source) rendered with KaTeX. Each distinct formula is
// typeset once and cloned afterwards, so re-renders and translation updates stay cheap.

import katex from "katex";
import { INLINE_MATH } from "../core/segment";

const typeset = new Map<string, HTMLElement>();

function formula(tex: string): HTMLElement {
  let el = typeset.get(tex);
  if (!el) {
    el = document.createElement("span");
    el.className = "ktx";
    katex.render(tex, el, { displayMode: false, throwOnError: false, strict: "ignore", trust: false, output: "htmlAndMathml" });
    el.title = tex;
    typeset.set(tex, el);
  }
  return el.cloneNode(true) as HTMLElement;
}

/** Replace the element's content with `text`, typesetting inline formulas when `math` is set. */
export function setRich(el: HTMLElement, text: string, math: boolean | undefined) {
  if (!math || !text.includes("$")) {
    el.textContent = text;
    return;
  }
  const parts: (string | Node)[] = [];
  let pos = 0;
  for (const m of text.matchAll(INLINE_MATH)) {
    if (m.index! > pos) parts.push(text.slice(pos, m.index));
    parts.push(formula(m[1].trim()));
    pos = m.index! + m[0].length;
  }
  if (pos < text.length) parts.push(text.slice(pos));
  el.replaceChildren(...parts);
}
