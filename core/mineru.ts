// Optional MinerU enrichment: attach LaTeX to display-math blocks and HTML to table blocks by
// matching page boxes. MinerU boxes are top-left origin, normalised to 0..1000 per page; SDT rects
// are PDF user space with bottom-left origin.

import type { Block, ZbrDocument } from "./model";

export interface MineruItem {
  type: string;
  page_idx: number;
  bbox?: [number, number, number, number];
  text?: string;
  text_format?: string;
  table_body?: string;
  table_caption?: string[];
}

export interface Enrichment {
  latex?: string;
  tableHtml?: string;
  /** Another block of the same MinerU item already shows it (SDT split one equation in pieces). */
  coveredBy?: string;
}

type Box = [number, number, number, number];

function area(b: Box) {
  return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
}

function overlap(a: Box, b: Box): number {
  const i: Box = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  const ia = area(i);
  return ia ? ia / Math.min(area(a), area(b)) : 0;
}

export function cleanLatex(text: string): string {
  return text.trim().replace(/^\$\$\s*/, "").replace(/\s*\$\$$/, "").trim();
}

function bestMatch(doc: ZbrDocument, block: Block, items: MineruItem[], want: string): { item: MineruItem | null; score: number } {
  let item: MineruItem | null = null;
  let score = 0;
  for (const r of block.pageRects) {
    const page = doc.pages[r[0]];
    if (!page) continue;
    const box: Box = [
      (r[1] / page.width) * 1000,
      ((page.height - r[4]) / page.height) * 1000,
      (r[3] / page.width) * 1000,
      ((page.height - r[2]) / page.height) * 1000,
    ];
    for (const it of items) {
      if (it.type !== want || it.page_idx !== r[0]) continue;
      const s = overlap(box, it.bbox!);
      if (s > score) {
        score = s;
        item = it;
      }
    }
  }
  return { item, score };
}

export function matchMineru(doc: ZbrDocument, items: MineruItem[]): Record<string, Enrichment> {
  const out: Record<string, Enrichment> = {};
  const candidates = items.filter((it) => it.bbox && ((it.type === "equation" && it.text) || (it.type === "table" && it.table_body)));
  const owner = new Map<MineruItem, string>();
  for (const b of doc.blocks) {
    // SDT often classifies tables as images, so image blocks may match MinerU tables.
    if (b.kind !== "math" && b.kind !== "table" && b.kind !== "image") continue;
    const { item: best, score } = bestMatch(doc, b, candidates, b.kind === "math" ? "equation" : "table");
    if (!best || score < 0.5) continue;
    const first = owner.get(best);
    if (first) {
      out[b.id] = { coveredBy: first };
      continue;
    }
    owner.set(best, b.id);
    out[b.id] = best.type === "equation" ? { latex: cleanLatex(best.text!) } : { tableHtml: best.table_body };
  }
  // Short text fragments SDT cut out of a display equation (e.g. a stray "ξother,j" line).
  for (const b of doc.blocks) {
    if (out[b.id] || b.kind === "math" || b.kind === "image" || b.kind === "table" || b.text.length > 60) continue;
    const { item, score } = bestMatch(doc, b, candidates, "equation");
    const first = item && owner.get(item);
    if (first && score >= 0.8) out[b.id] = { coveredBy: first };
  }
  return out;
}
