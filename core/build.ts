// SDT -> ZbrDocument.

import { textHash } from "./hash";
import type { Block, BlockKind, Sentence, TextSegment, ZbrDocument } from "./model";
import { splitSentences } from "./segment";
import {
  isTextNode,
  type PageRect,
  type SdtBlockNode,
  type SdtDocument,
  type SdtOutlineItem,
  type SdtTextNode,
} from "./sdt-types";

const TEXT_KINDS: Record<string, BlockKind> = {
  paragraph: "paragraph",
  heading: "heading",
  caption: "caption",
  math: "math",
  listitem: "listitem",
  preformatted: "pre",
  note: "paragraph",
};

const REFERENCE_HEADING = /^(?:[ivx\d]+\.?\s*)?(references|bibliography|literature cited|参考文献)\s*$/i;
const APPENDIX_HEADING = /^(?:[a-z\d]+\.?\s*)?(appendix|appendices|附录)/i;

function getNode(content: SdtBlockNode[], path: number[]): SdtBlockNode | undefined {
  let node: any = { content };
  for (const i of path) {
    node = node?.content?.[i];
  }
  return node;
}

function outlineLevels(outline: SdtOutlineItem[] | undefined): Map<string, number> {
  const levels = new Map<string, number>();
  const walk = (items: SdtOutlineItem[] | undefined, depth: number) => {
    for (const it of items ?? []) {
      if (it.ref) levels.set(it.ref.join("."), depth);
      walk(it.children, depth + 1);
    }
  };
  walk(outline, 1);
  return levels;
}

interface RawBlock {
  path: number[];
  node: SdtBlockNode;
  kind: BlockKind;
}

function collect(content: SdtBlockNode[]): RawBlock[] {
  const out: RawBlock[] = [];
  const walk = (node: SdtBlockNode, path: number[]) => {
    if (node.flowClass === "excluded") return;
    if (node.previousPart) return; // merged into the head of its part chain
    const children = node.content ?? [];
    const hasTextChildren = children.length > 0 && children.every((c) => isTextNode(c as any));
    if (node.type === "image") {
      out.push({ path, node, kind: "image" });
      return;
    }
    if (node.type === "table") {
      out.push({ path, node, kind: "table" });
      return;
    }
    if (TEXT_KINDS[node.type] && (hasTextChildren || children.length === 0)) {
      out.push({ path, node, kind: TEXT_KINDS[node.type] });
      return;
    }
    children.forEach((c, i) => {
      if (!isTextNode(c as any)) walk(c as SdtBlockNode, path.concat(i));
    });
  };
  content.forEach((b, i) => walk(b, [i]));
  return out;
}

export function buildDocument(sdt: SdtDocument, attachmentKey = ""): ZbrDocument {
  const levels = outlineLevels(sdt.catalog.outline);
  const raws = collect(sdt.content);
  const blocks: Block[] = [];

  for (const raw of raws) {
    // Follow the part chain.
    const parts: { path: number[]; node: SdtBlockNode }[] = [{ path: raw.path, node: raw.node }];
    let cur = raw.node;
    const seen = new Set([raw.path.join(".")]);
    while (cur.nextPart && !seen.has(cur.nextPart.join("."))) {
      const next = getNode(sdt.content, cur.nextPart);
      if (!next) break;
      seen.add(cur.nextPart.join("."));
      parts.push({ path: cur.nextPart, node: next });
      cur = next;
    }

    let text = "";
    const segments: TextSegment[] = [];
    const pageRects: PageRect[] = [];
    for (const part of parts) {
      pageRects.push(...(part.node.anchor?.pageRects ?? []));
      (part.node.content ?? []).forEach((c, i) => {
        if (!isTextNode(c as any)) return;
        const t = (c as SdtTextNode).text;
        if (!t) return;
        if (text && segments.length && !/\s$/.test(text) && !/^\s/.test(t) && part !== parts[0] && i === 0) {
          text += " ";
        }
        segments.push({
          nodePath: part.path.concat(i),
          start: text.length,
          nodeStart: 0,
          length: t.length,
          style: (c as SdtTextNode).style,
        });
        text += t;
      });
    }

    const block: Block = {
      id: raw.path.join("."),
      kind: raw.kind,
      parts: parts.map((p) => p.path),
      text,
      segments,
      sentences: [],
      pageRects,
      translatable: false,
    };
    if (raw.kind === "heading") block.level = levels.get(block.id) ?? 2;
    if (raw.node.reference) block.role = "reference";
    if (raw.kind === "caption") block.role = "caption";
    blocks.push(block);
  }

  mergeDropCaps(blocks);
  markReferences(blocks);
  markFrontMatter(blocks);
  synthesizeTables(blocks, sdt.content);
  mergeSplitParagraphs(blocks);
  assignSentences(blocks);

  const pages = sdt.catalog.pages.map((p) => {
    const vr = p.viewRect ?? [0, 0, 612, 792];
    return { width: vr[2] - vr[0], height: vr[3] - vr[1], label: p.label };
  });
  const title = sdt.catalog.outline?.[0]?.title ?? blocks.find((b) => b.kind === "heading")?.text;
  const version = sdt.metadata.processor.version;
  return {
    docId: [attachmentKey, sdt.metadata.source.hash, `sdt${version}`].join("|"),
    pdfHash: sdt.metadata.source.hash,
    parser: { kind: "sdt", version, schema: sdt.schemaVersion },
    title,
    pages,
    blocks,
  };
}

const TABLE_CAPTION = /^\s*TABLE\s+([IVXLC]+|\d+)\b/i;

/**
 * SDT keeps a table's caption but often emits no node for the table body. Recover the body as
 * the empty column region below a "TABLE n" caption, down to the next node, so it can be cropped
 * from the PDF (and later matched with MinerU's HTML table).
 */
function synthesizeTables(blocks: Block[], content: SdtBlockNode[]) {
  const nodeRects: PageRect[] = [];
  for (const n of content) nodeRects.push(...(n.anchor?.pageRects ?? []));
  for (let i = blocks.length - 1; i >= 0; i--) {
    const cap = blocks[i];
    if (cap.kind !== "caption" || !TABLE_CAPTION.test(cap.text) || !cap.pageRects.length) continue;
    const [page, cx1, cy1, cx2] = cap.pageRects[cap.pageRects.length - 1];
    // Already has a body if an image/table starts right under the caption.
    const next = blocks[i + 1];
    const nr = next?.pageRects[0];
    if (nr && (next.kind === "table" || next.kind === "image") && nr[0] === page && nr[4] > cy1 - 30) continue;
    const onPage = nodeRects.filter((r) => r[0] === page);
    if (!onPage.length) continue;
    const pageX1 = Math.min(...onPage.map((r) => r[1]));
    const pageX2 = Math.max(...onPage.map((r) => r[3]));
    const mid = (pageX1 + pageX2) / 2;
    const center = (cx1 + cx2) / 2;
    const wide = cx2 - cx1 > (pageX2 - pageX1) * 0.6;
    const inColumn = (r: PageRect) => wide || ((r[1] + r[3]) / 2 < mid) === (center < mid);
    const col = onPage.filter((r) => inColumn(r) && r[3] - r[1] > 20);
    const x1 = Math.min(cx1, ...col.map((r) => r[1]));
    const x2 = Math.max(cx2, ...col.map((r) => r[3]));
    // Nearest node below the caption that overlaps the column horizontally.
    const below = onPage.filter((r) => r[4] < cy1 - 1 && r[3] > x1 && r[1] < x2);
    const bottom = below.length ? Math.max(...below.map((r) => r[4])) : Math.min(...onPage.map((r) => r[2]));
    if (cy1 - bottom < 15) continue;
    const id = `${cap.id}.t`;
    blocks.splice(i + 1, 0, {
      id,
      kind: "table",
      parts: [],
      text: "",
      segments: [],
      sentences: [],
      // Tables often run slightly wider than the text column; keep clear of the caption descenders.
      pageRects: [[page, x1 - 8, bottom + 1, x2 + 8, cy1 - 3]],
      translatable: false,
    });
  }
}

/** A one-letter heading followed by a paragraph is a drop cap ("W" + "ITH the ..."). */
function mergeDropCaps(blocks: Block[]) {
  for (let i = 0; i < blocks.length - 1; i++) {
    const h = blocks[i];
    const p = blocks[i + 1];
    if (h.kind !== "heading" || !/^[A-Z]$/.test(h.text.trim()) || p.kind !== "paragraph") continue;
    if (!/^[A-Z]/.test(p.text)) continue;
    const letter = h.text.trim();
    p.segments = [
      { nodePath: h.segments[0]?.nodePath ?? h.parts[0].concat(0), start: 0, nodeStart: 0, length: 1, style: h.segments[0]?.style },
      ...p.segments.map((s) => ({ ...s, start: s.start + 1 })),
    ];
    p.text = letter + p.text;
    p.pageRects = [...h.pageRects, ...p.pageRects];
    p.parts = [...h.parts, ...p.parts];
    blocks.splice(i, 1);
  }
}

/** Floats and footnotes that may sit between the two halves of a paragraph broken by a column or page end. */
const isInterruption = (b: Block) => b.kind === "image" || b.kind === "table" || b.kind === "caption" || b.role === "footnote";

/**
 * Join paragraphs that SDT left split at a column or page break: the first half ends without
 * terminal punctuation and the next block, past any floats, is a body paragraph. A heading,
 * list or display equation in between ends the search, so text around equations stays apart.
 */
/** Decide what gets translated and split it into sentence units. */
export function assignSentences(blocks: Block[]) {
  for (const b of blocks) {
    const hasWords = /[A-Za-z]{2,}/.test(b.text);
    b.translatable =
      hasWords &&
      b.role !== "reference" &&
      b.role !== "footnote" &&
      (b.kind === "paragraph" || b.kind === "listitem" || b.kind === "caption" || b.kind === "heading");
    if (!b.translatable) continue;
    const ranges = b.kind === "heading" ? [{ start: 0, end: b.text.length }] : splitSentences(b.text);
    b.sentences = ranges.map((r, i): Sentence => {
      const t = b.text.slice(r.start, r.end);
      return { id: `${b.id}:${i}`, start: r.start, end: r.end, text: t, hash: textHash(t) };
    });
  }
}

export function mergeSplitParagraphs(blocks: Block[], { onlyMidSentence = false } = {}) {
  for (let i = 0; i < blocks.length; i++) {
    const a = blocks[i];
    if (a.kind !== "paragraph" || a.role || /[.?!:;]["')\]]?\s*$/.test(a.text)) continue;
    let j = i + 1;
    while (j < blocks.length && isInterruption(blocks[j])) j++;
    const b = blocks[j];
    if (!b || b.kind !== "paragraph" || b.role) continue;
    if (onlyMidSentence && !/^\s*[a-z]/.test(b.text)) continue;
    const sep = /[\s-]$/.test(a.text) ? "" : " ";
    const offset = a.text.length + sep.length;
    a.segments.push(...b.segments.map((s) => ({ ...s, start: s.start + offset })));
    a.text += sep + b.text;
    a.pageRects.push(...b.pageRects);
    a.parts.push(...b.parts);
    blocks.splice(j, 1);
    i--; // the merged paragraph may continue into yet another column
  }
}

// Publisher front matter that SDT keeps as ordinary paragraphs: submission history, author
// affiliations, DOI and copyright lines. Only short blocks that start with (or carry) these
// fixed phrases qualify, so body text is never caught.
const FRONT_MATTER = [
  /^\s*Manuscript received\b/i,
  /^\s*(Received|Accepted|Available online|Published)\s*:?\s*\d/i,
  /^[^.]{0,200}\bis (also |now )?with (the )?[^.]*(e-?mail|\.edu|University|Institute|Laboratory)/i,
  /^\s*\*?\s*Corresponding author\b/i,
  /^\s*E-?mail addresses?\s*:/i,
  /^\s*Color versions of one or more (of the )?figures\b/i,
  /^\s*Digital Object Identifier\b/i,
  /^\s*(https?:\/\/)?doi\.org\/\S+\s*$/i,
  /©|\bPersonal use is permitted\b|\bAll rights reserved\b/i,
];

export function markFrontMatter(blocks: Block[]) {
  for (const b of blocks) {
    if (b.role || b.text.length > 600) continue;
    if (b.kind !== "paragraph" && b.kind !== "listitem") continue;
    if (FRONT_MATTER.some((re) => re.test(b.text))) b.role = "footnote";
  }
}

export function markReferences(blocks: Block[]) {
  let inRefs = false;
  for (const b of blocks) {
    if (b.kind === "heading") {
      if (REFERENCE_HEADING.test(b.text.trim())) {
        inRefs = true;
        continue;
      }
      if (inRefs && APPENDIX_HEADING.test(b.text.trim())) inRefs = false;
      continue;
    }
    if (inRefs && (b.kind === "paragraph" || b.kind === "listitem")) b.role = "reference";
  }
}
