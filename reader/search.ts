// Find in page (Ctrl+F). Zotero has no find bar for plugin tabs, so the page brings its own.
// It searches the document model (English and Chinese of every sentence), not the DOM, so
// sentences hidden by the display mode or not yet laid out are found too; a hit is shown on the
// sentence's rendered span, in either language.

import type { Block } from "../core/model";
import { translationFor, type Translations } from "./render";
import { spansOf } from "./spans";

export interface SearchCtx {
  blocks: () => Iterable<Block>;
  getTranslations(): Translations;
}

interface Hit {
  unitId: string;
  lang: "en" | "zh";
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");

export function installSearch(ctx: SearchCtx) {
  const bar = document.createElement("div");
  bar.id = "find-bar";
  bar.hidden = true;
  // Built element by element: the privileged reader page sanitizes form controls out of innerHTML.
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, id: string, text = "", title = "") => {
    const el = document.createElement(tag);
    el.id = id;
    if (text) el.textContent = text;
    if (title) el.title = title;
    return el;
  };
  const input = make("input", "find-input");
  input.type = "search";
  input.placeholder = "查找英文或中文…";
  input.autocomplete = "off";
  const count = make("span", "find-count");
  const prev = make("button", "find-prev", "↑", "上一个（Shift+Enter）");
  const next = make("button", "find-next", "↓", "下一个（Enter）");
  const closeBtn = make("button", "find-close", "×", "关闭（Esc）");
  bar.append(input, count, prev, next, closeBtn);
  document.body.append(bar);
  let hits: Hit[] = [];
  let at = -1;
  let marked: HTMLElement[] = [];
  const highlights = (CSS as any).highlights as Map<string, unknown> | undefined;

  function clearMarks() {
    for (const el of marked) el.classList.remove("found", "found-cur");
    marked = [];
    highlights?.delete("zbr-find");
  }

  function run(jump = true) {
    clearMarks();
    const q = norm(input.value.trim());
    hits = [];
    at = -1;
    if (q) {
      const tr = ctx.getTranslations();
      for (const b of ctx.blocks())
        for (const s of b.sentences) {
          if (norm(s.text).includes(q)) hits.push({ unitId: s.id, lang: "en" });
          const zh = translationFor(s, tr);
          if (zh && norm(zh).includes(q)) hits.push({ unitId: s.id, lang: "zh" });
        }
    }
    for (const h of hits)
      for (const el of spansOf(h.unitId)) {
        el.classList.add("found");
        marked.push(el);
      }
    if (hits.length && jump) go(0);
    else count.textContent = q ? (hits.length ? `${hits.length} 处` : "无结果") : "";
  }

  /** The rendered span of a hit: its own language if shown, else the other one. */
  function spanOf(h: Hit): HTMLElement | undefined {
    const spans = spansOf(h.unitId);
    const own = spans.find((el) => (h.lang === "zh" ? el.closest(".zh") : !el.closest(".zh")));
    return own ?? spans[0];
  }

  function go(i: number) {
    if (!hits.length) return;
    at = (i + hits.length) % hits.length;
    count.textContent = `${at + 1}/${hits.length}`;
    for (const el of marked) el.classList.remove("found-cur");
    const el = spanOf(hits[at]);
    if (!el) return;
    el.classList.add("found-cur");
    el.scrollIntoView({ block: "center" });
    markText(el);
  }

  // The matched characters of the current hit, where the browser supports custom highlights.
  function markText(el: HTMLElement) {
    if (!highlights) return;
    const q = norm(input.value.trim());
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const ranges: Range[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.nodeValue ?? "").toLowerCase();
      let from = text.indexOf(q);
      while (from >= 0 && q) {
        const r = new Range();
        r.setStart(n, from);
        r.setEnd(n, from + q.length);
        ranges.push(r);
        from = text.indexOf(q, from + q.length);
      }
    }
    const Highlight = (window as any).Highlight;
    if (Highlight) highlights.set("zbr-find", new Highlight(...ranges));
  }

  function open() {
    const tb = document.getElementById("toolbar");
    if (tb) bar.style.top = `${tb.getBoundingClientRect().bottom + 8}px`;
    bar.hidden = false;
    const sel = window.getSelection()?.toString().trim();
    if (sel && sel.length < 80) input.value = sel;
    input.focus();
    input.select();
    if (input.value) run();
  }

  function close() {
    bar.hidden = true;
    clearMarks();
  }

  let timer: number | undefined;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = window.setTimeout(run, 150);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(timer);
      if (at < 0) run();
      else go(at + (e.shiftKey ? -1 : 1));
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
  next.addEventListener("click", () => go(at + 1));
  prev.addEventListener("click", () => go(at - 1));
  closeBtn.addEventListener("click", close);
  // Capture phase: before Zotero's own Ctrl+F (library search) sees the key.
  document.addEventListener(
    "keydown",
    (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        e.stopPropagation();
        open();
      } else if (e.key === "F3" && !bar.hidden) {
        e.preventDefault();
        go(at + (e.shiftKey ? -1 : 1));
      }
    },
    true,
  );

  /** After a full re-render the spans are new: mark them again. */
  function refresh() {
    if (bar.hidden || !input.value.trim()) return;
    const cur = at;
    run(false);
    if (cur >= 0 && hits.length) {
      at = Math.min(cur, hits.length - 1);
      count.textContent = `${at + 1}/${hits.length}`;
      for (const el of marked) el.classList.remove("found-cur");
      spanOf(hits[at])?.classList.add("found-cur");
    }
  }

  return { open, close, refresh };
}
