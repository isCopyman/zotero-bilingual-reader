// A whole document built from a MinerU parse (content_list.json): its own reading order, inline
// formulas as LaTeX, display equations and tables from MinerU. Page geometry comes from the
// Zotero document so figures can still be cropped from the PDF and blocks located in it.

import { assignSentences, markFrontMatter, markReferences, mergeSplitParagraphs } from "./build";
import { cleanLatex, type MineruItem } from "./mineru";
import type { Block, BlockKind, ZbrDocument } from "./model";

export interface MineruContentItem extends MineruItem {
  text_level?: number;
  list_items?: string[];
  image_caption?: string[];
  image_footnote?: string[];
  table_footnote?: string[];
}

const SKIPPED = new Set(["header", "footer", "page_number", "aside_text", "discarded"]);

/** Heading depth from its numbering: "II." 1, "B." 2, "3)" 3, "2.1" 2; unnumbered 1. */
export function headingLevel(text: string, prevLetter = ""): number {
  const t = text.trim();
  // "C." after "B." is a sub-section letter, not the Roman numeral 100 (likewise I, V, X, L).
  const one = /^([A-Z])\.\s/.exec(t)?.[1];
  if (one && prevLetter && one.charCodeAt(0) === prevLetter.charCodeAt(0) + 1) return 2;
  if (/^[IVXLC]+\.\s/.test(t)) return 1;
  if (/^[A-Z]\.\s/.test(t)) return 2;
  if (/^\d+\)\s/.test(t)) return 3;
  const m = /^(\d+(?:\.\d+)*)\.?\s/.exec(t);
  if (m) return Math.min(4, m[1].split(".").length);
  return 1;
}

export function buildMineruDocument(items: MineruContentItem[], base: ZbrDocument, attachmentKey = ""): ZbrDocument {
  const blocks: Block[] = [];
  let n = 0;
  const rects = (it: MineruItem): Block["pageRects"] => {
    const page = base.pages[it.page_idx];
    if (!it.bbox || !page) return [];
    const [x1, y1, x2, y2] = it.bbox;
    const { width: w, height: h } = page;
    return [[it.page_idx, (x1 / 1000) * w, h - (y2 / 1000) * h, (x2 / 1000) * w, h - (y1 / 1000) * h]];
  };
  const add = (kind: BlockKind, text: string, it: MineruItem, extra: Partial<Block> = {}) => {
    const t = text.trim();
    blocks.push({
      id: `m${n++}`,
      kind,
      parts: [],
      text: t,
      segments: t ? [{ nodePath: [], start: 0, nodeStart: 0, length: t.length }] : [],
      sentences: [],
      pageRects: rects(it),
      translatable: false,
      inlineMath: t.includes("$"),
      ...extra,
    });
  };

  let prevLetter = "";
  for (const it of items) {
    if (SKIPPED.has(it.type)) continue;
    switch (it.type) {
      case "equation":
        add("math", "", it, { mineru: { latex: cleanLatex(it.text ?? "") } });
        break;
      case "image":
        add("image", "", it);
        for (const c of it.image_caption ?? []) add("caption", c, it, { role: "caption" });
        for (const c of it.image_footnote ?? []) add("paragraph", c, it, { role: "footnote" });
        break;
      case "table":
        for (const c of it.table_caption ?? []) add("caption", c.replace(/\s*\n\s*/g, " "), it, { role: "caption" });
        add("table", "", it, it.table_body ? { mineru: { tableHtml: it.table_body } } : {});
        for (const c of it.table_footnote ?? []) add("paragraph", c, it, { role: "footnote" });
        break;
      case "list":
        for (const li of it.list_items ?? []) add("listitem", li.replace(/^\s*[-•·]\s+/, ""), it);
        break;
      case "page_footnote":
        add("paragraph", it.text ?? "", it, { role: "footnote" });
        break;
      default:
        if (!it.text?.trim()) break;
        if (it.text_level) {
          const level = headingLevel(it.text, prevLetter);
          prevLetter = level === 2 ? (/^\s*([A-Z])\./.exec(it.text)?.[1] ?? "") : level === 1 ? "" : prevLetter;
          add("heading", it.text, it, { level });
        }
        else add("paragraph", it.text, it);
    }
  }
  // Reading positions and sizes of table/image rects come from MinerU boxes; captions share the
  // box of their float, which is close enough for "locate in PDF".
  markReferences(blocks);
  markFrontMatter(blocks);
  // MinerU already joins most column breaks; only finish sentences it left open.
  mergeSplitParagraphs(blocks, { onlyMidSentence: true });
  assignSentences(blocks);
  return {
    docId: [attachmentKey, base.pdfHash, "mineru"].join("|"),
    pdfHash: base.pdfHash,
    parser: { kind: "mineru", version: 1, schema: "content_list" },
    title: blocks.find((b) => b.kind === "heading")?.text ?? base.title,
    pages: base.pages,
    blocks,
  };
}
