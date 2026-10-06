// Side panel on the left: the paper's headings (with their translations, the current section
// marked while scrolling, sub-sections foldable) and the reader's bookmarks. The panel itself
// folds away; open state and tab are reader preferences, bookmarks are kept per paper.

import type { Bookmark, HighlightView, ZbrHost } from "../core/host-api";
import type { Block, ZbrDocument } from "../core/model";
import { translationFor, type Translations } from "./render";

export type OutlineTab = "toc" | "marks" | "notes";

export interface OutlineCtx {
  host: ZbrHost;
  getDoc(): ZbrDocument;
  getTranslations(): Translations;
  /** Block at the top of the view. */
  currentBlock(): string | null;
  getHighlights(): HighlightView[];
  /** Show a highlight's card (edit comment, colour, open in PDF). */
  openHighlight(id: string): void;
  isOpen(): boolean;
  getTab(): OutlineTab;
  setOpen(open: boolean, tab?: OutlineTab): void;
  toast(msg: string): void;
}

const letters = (s: string) => s.toLowerCase().replace(/\$[^$]*\$/g, "").replace(/[^a-z0-9]/g, "");
const snippet = (s: string, n = 60) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

const sectionOf = (blockId: string) => document.querySelector<HTMLElement>(`section.blk[data-b="${CSS.escape(blockId)}"]`);

export function installOutline(ctx: OutlineCtx) {
  const panel = el("aside");
  panel.id = "outline";
  const tabs = el("div", "ol-tabs");
  const tocTab = el("button", "", "目录");
  const marksTab = el("button", "", "书签");
  const notesTab = el("button", "", "注释");
  const fold = el("button", "ol-close", "×");
  fold.title = "收起（快捷键 T）";
  tabs.append(tocTab, marksTab, notesTab, fold);
  const toc = el("nav", "ol-toc");
  const marks = el("div", "ol-marks");
  const notes = el("div", "ol-notes");
  panel.append(tabs, toc, marks, notes);
  document.body.append(panel);

  let bookmarks: Bookmark[] = [];
  let headings: { block: Block; item: HTMLElement }[] = [];
  const collapsed = new Set<string>();

  function syncOpen() {
    const open = ctx.isOpen();
    const tab = ctx.getTab();
    panel.hidden = !open;
    document.body.classList.toggle("outline-open", open);
    tocTab.classList.toggle("on", tab === "toc");
    marksTab.classList.toggle("on", tab === "marks");
    notesTab.classList.toggle("on", tab === "notes");
    toc.hidden = tab !== "toc";
    marks.hidden = tab !== "marks";
    notes.hidden = tab !== "notes";
    placePanel();
    if (open) markCurrent();
  }

  // Below the toolbar, whose height changes as it wraps.
  function placePanel() {
    const tb = document.getElementById("toolbar");
    panel.style.top = `${tb ? tb.getBoundingClientRect().bottom : 0}px`;
  }
  const tb = document.getElementById("toolbar");
  if (tb) new ResizeObserver(placePanel).observe(tb);

  function jump(blockId: string) {
    const s = sectionOf(blockId);
    if (!s) return false;
    const top = s.getBoundingClientRect().top + window.scrollY - (tb?.getBoundingClientRect().bottom ?? 0) - 8;
    window.scrollTo({ top });
    markCurrent();
    s.classList.remove("ol-flash");
    void s.offsetWidth;
    s.classList.add("ol-flash");
    return true;
  }

  function renderToc() {
    const doc = ctx.getDoc();
    const tr = ctx.getTranslations();
    const list = doc.blocks.filter((b) => b.kind === "heading" && b.text.trim());
    toc.replaceChildren();
    headings = [];
    if (!list.length) {
      toc.append(el("p", "ol-empty", "这篇论文没有识别出章节标题。"));
      return;
    }
    const minLevel = Math.min(...list.map((b) => b.level ?? 1));
    list.forEach((b, i) => {
      const level = (b.level ?? 1) - minLevel;
      const item = el("div", "ol-item");
      item.dataset.b = b.id;
      item.dataset.level = String(level);
      item.style.paddingLeft = `${8 + level * 14}px`;
      const hasChildren = (list[i + 1]?.level ?? 0) > (b.level ?? 1);
      const twisty = el("span", "ol-twisty", hasChildren ? (collapsed.has(b.id) ? "▸" : "▾") : "");
      twisty.addEventListener("click", (e) => {
        e.stopPropagation();
        if (collapsed.has(b.id)) collapsed.delete(b.id);
        else collapsed.add(b.id);
        renderToc();
        markCurrent();
      });
      const text = el("span", "ol-text");
      text.append(el("span", "ol-en", b.text));
      const zh = b.sentences.map((s) => translationFor(s, tr)).filter(Boolean).join("");
      if (zh) text.append(el("span", "ol-zh", zh));
      text.title = b.text + (zh ? `\n${zh}` : "");
      item.append(twisty, text);
      item.addEventListener("click", () => jump(b.id));
      toc.append(item);
      headings.push({ block: b, item });
    });
    // Hide the sub-sections of folded headings.
    let hideBelow = Infinity;
    for (const h of headings) {
      const lv = h.block.level ?? 1;
      if (lv <= hideBelow) hideBelow = Infinity;
      h.item.hidden = hideBelow !== Infinity;
      if (!h.item.hidden && collapsed.has(h.block.id)) hideBelow = lv;
    }
  }

  /** The heading whose section is at the top of the view. */
  function markCurrent() {
    if (panel.hidden || toc.hidden || !headings.length) return;
    const limit = (tb?.getBoundingClientRect().bottom ?? 0) + 40;
    let cur: HTMLElement | null = null;
    for (const h of headings) {
      const s = sectionOf(h.block.id);
      if (!s) continue;
      if (s.getBoundingClientRect().top > limit) break;
      cur = h.item;
    }
    for (const h of headings) h.item.classList.toggle("cur", h.item === cur);
    if (cur && !cur.hidden) {
      const r = cur.getBoundingClientRect();
      const p = toc.getBoundingClientRect();
      if (r.top < p.top || r.bottom > p.bottom) cur.scrollIntoView({ block: "nearest" });
    }
  }

  /** The block a bookmark points at in the document shown (ids differ between sources). */
  function resolve(m: Bookmark): Block | undefined {
    const doc = ctx.getDoc();
    const own = doc.blocks.find((b) => b.id === m.blockId);
    const key = letters(m.text).slice(0, 40);
    if (own && letters(own.text).startsWith(key.slice(0, 20))) return own;
    if (key.length < 8) return own;
    return doc.blocks.find((b) => letters(b.text).startsWith(key)) ?? doc.blocks.find((b) => key && letters(b.text).includes(key));
  }

  function renderMarks() {
    marks.replaceChildren();
    const add = el("button", "ol-add", "＋ 书签当前位置");
    add.title = "快捷键 B";
    add.addEventListener("click", () => toggleHere());
    marks.append(add);
    if (!bookmarks.length) {
      marks.append(el("p", "ol-empty", "还没有书签。读到想回头再看的地方，点上面的按钮或按 B。"));
    }
    for (const m of bookmarks) {
      const b = resolve(m);
      const item = el("div", "ol-item ol-mark");
      const text = el("span", "ol-text");
      const head = b ? sectionTitle(b) : "";
      const page = b?.pageRects[0]?.[0] ?? m.page;
      text.append(el("span", "ol-en", snippet(head || b?.text || m.text, 50)));
      text.append(el("span", "ol-zh", [page !== undefined ? `第 ${page + 1} 页` : "", head ? snippet(b?.text || m.text, 40) : ""].filter(Boolean).join(" · ")));
      text.title = b?.text || m.text;
      const del = el("button", "ol-del", "×");
      del.title = "删除书签";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        bookmarks = bookmarks.filter((x) => x !== m);
        save();
      });
      item.append(text, del);
      if (!b) item.classList.add("missing");
      item.addEventListener("click", () => {
        if (!b || !jump(b.id)) ctx.toast("在当前来源里找不到这个书签的位置");
      });
      marks.append(item);
    }
    markBookmarked();
  }

  /** Heading of the section a block is in, for naming bookmarks. */
  function sectionTitle(b: Block): string {
    const blocks = ctx.getDoc().blocks;
    for (let i = blocks.indexOf(b); i >= 0; i--) if (blocks[i].kind === "heading" && blocks[i].text.trim()) return blocks[i].text;
    return "";
  }

  /** First block wholly below the toolbar, preferring text over figures and formulas. */
  function blockHere(): Block | undefined {
    const limit = (tb?.getBoundingClientRect().bottom ?? 0) - 4;
    const doc = ctx.getDoc();
    let fallback: Block | undefined;
    for (const s of Array.from(document.querySelectorAll<HTMLElement>("section.blk"))) {
      const r = s.getBoundingClientRect();
      if (r.bottom <= limit) continue;
      if (r.top > window.innerHeight * 0.6) break;
      const b = doc.blocks.find((x) => x.id === s.dataset.b);
      if (!b) continue;
      fallback ??= b;
      if (r.top >= limit && b.text.trim() && b.kind !== "math") return b;
    }
    const id = ctx.currentBlock();
    return fallback ?? doc.blocks.find((x) => x.id === id);
  }

  /** A small ribbon beside bookmarked paragraphs. */
  function markBookmarked() {
    document.querySelectorAll("section.blk.bookmarked").forEach((s) => s.classList.remove("bookmarked"));
    for (const m of bookmarks) {
      const b = resolve(m);
      if (b) sectionOf(b.id)?.classList.add("bookmarked");
    }
  }

  /** PDF highlights of this paper, in reading order, like Zotero's annotation sidebar. */
  function renderNotes() {
    notes.replaceChildren();
    const order = new Map<string, number>();
    ctx.getDoc().blocks.forEach((b, i) => b.sentences.forEach((s, k) => order.set(s.id, i * 1000 + k)));
    const shown = ctx
      .getHighlights()
      .map((h) => ({ h, at: Math.min(...h.unitIds.map((u) => order.get(u) ?? Infinity)) }))
      .filter((x) => x.at !== Infinity)
      .sort((a, b) => a.at - b.at);
    notesTab.textContent = shown.length ? `注释 ${shown.length}` : "注释";
    if (!shown.length) {
      notes.append(el("p", "ol-empty", "这篇还没有高亮。选中句子后点色块即可高亮（同时建在原 PDF 上）；在 PDF 里做的高亮也会列在这里。"));
      return;
    }
    for (const { h } of shown) {
      const item = el("div", "ol-note");
      item.style.setProperty("--mark", h.color);
      item.append(el("div", "ol-note-text", h.text || "（无文字）"));
      if (h.comment) item.append(el("div", "ol-note-comment", h.comment));
      item.title = "点击跳到这句；再点一次打开批注卡片";
      item.addEventListener("click", () => {
        const id = h.unitIds.find((u) => document.querySelector(`.s[data-u="${CSS.escape(u)}"]`));
        const span = id && document.querySelector<HTMLElement>(`.s[data-u="${CSS.escape(id)}"]`);
        if (!span) return ctx.toast("在当前显示里找不到这条高亮的句子");
        const r = span.getBoundingClientRect();
        const near = r.top > 0 && r.bottom < window.innerHeight;
        if (near && item.classList.contains("cur")) return ctx.openHighlight(h.id);
        notes.querySelectorAll(".ol-note.cur").forEach((n) => n.classList.remove("cur"));
        item.classList.add("cur");
        span.scrollIntoView({ block: "center" });
        span.classList.remove("ol-flash");
        void span.offsetWidth;
        span.classList.add("ol-flash");
      });
      notes.append(item);
    }
  }

  function save() {
    ctx.host.setBookmarks(bookmarks).catch((e) => ctx.toast(`保存书签失败：${e?.message ?? e}`));
    renderMarks();
  }

  /** Bookmark the paragraph at the top of the view, or remove its bookmark. */
  function toggleHere() {
    const block = blockHere();
    if (!block) return;
    const existing = bookmarks.find((m) => resolve(m)?.id === block.id);
    if (existing) {
      bookmarks = bookmarks.filter((m) => m !== existing);
      ctx.toast("已删除这里的书签");
    } else {
      bookmarks.push({ blockId: block.id, text: block.text.slice(0, 120), page: block.pageRects[0]?.[0], t: Date.now() });
      // In reading order, wherever they were added from.
      const order = new Map(ctx.getDoc().blocks.map((b, i) => [b.id, i]));
      bookmarks.sort((a, b) => (order.get(resolve(a)?.id ?? "") ?? 1e9) - (order.get(resolve(b)?.id ?? "") ?? 1e9));
      ctx.toast("已添加书签");
    }
    save();
  }

  tocTab.addEventListener("click", () => ctx.setOpen(true, "toc"));
  marksTab.addEventListener("click", () => ctx.setOpen(true, "marks"));
  notesTab.addEventListener("click", () => ctx.setOpen(true, "notes"));
  fold.addEventListener("click", () => ctx.setOpen(false));

  let timer: number | undefined;
  window.addEventListener(
    "scroll",
    () => {
      if (timer !== undefined || panel.hidden) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        markCurrent();
      }, 120);
    },
    { passive: true },
  );

  void ctx.host
    .getBookmarks()
    .then((list) => {
      bookmarks = list ?? [];
      renderMarks();
    })
    .catch(() => {});

  return {
    /** After the document was rendered again (mode, source or font change). */
    refresh() {
      renderToc();
      renderMarks();
      renderNotes();
      syncOpen();
    },
    /** Heading translations arrived. */
    refreshToc() {
      renderToc();
      markCurrent();
    },
    /** PDF highlights changed. */
    refreshNotes: renderNotes,
    syncOpen,
    toggle() {
      ctx.setOpen(!ctx.isOpen());
    },
    toggleHere,
  };
}
