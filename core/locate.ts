// Sentence <-> PDF geometry, from the SDT text maps. Rects are PDF user space, the same space
// Zotero stores annotation positions in.

import type { Block, ZbrDocument } from "./model";
import { isTextNode, type SdtBlockNode, type SdtDocument, type SdtTextNode } from "./sdt-types";
import { decodeTextMap, mergeLineRects, rectsForNodeRange, type CharRect } from "./textmap";

export interface PagePosition {
  pageIndex: number;
  rects: number[][];
}

function nodeAt(content: SdtBlockNode[], path: number[]): any {
  let n: any = { content };
  for (const i of path) n = n?.content?.[i];
  return n;
}

export class Locator {
  private chars = new Map<string, CharRect[]>();
  private unitCache = new Map<string, PagePosition[]>();
  private pageOrder: Map<string, number> | null = null;

  constructor(
    private sdt: SdtDocument,
    private doc: ZbrDocument,
  ) {}

  private charsOf(path: number[]): { text: string; chars: CharRect[] } | null {
    const node = nodeAt(this.sdt.content, path) as SdtTextNode | undefined;
    if (!node || typeof node.text !== "string") return null;
    const key = path.join(".");
    let chars = this.chars.get(key);
    if (!chars) {
      chars = decodeTextMap(node.anchor?.textMap);
      this.chars.set(key, chars);
    }
    return { text: node.text, chars };
  }

  /** Character rects of [start, end) in a block's logical text. */
  charRects(block: Block, start: number, end: number): CharRect[] {
    const out: CharRect[] = [];
    for (const seg of block.segments) {
      const a = Math.max(start, seg.start);
      const b = Math.min(end, seg.start + seg.length);
      if (a >= b) continue;
      const n = this.charsOf(seg.nodePath);
      if (!n) continue;
      const r = rectsForNodeRange(n.text, n.chars, seg.nodeStart + a - seg.start, seg.nodeStart + b - seg.start);
      if (r) out.push(...r);
    }
    return out;
  }

  /** Line boxes of one sentence, grouped by page. */
  unitPositions(block: Block, unitId: string): PagePosition[] {
    const hit = this.unitCache.get(unitId);
    if (hit) return hit;
    const s = block.sentences.find((x) => x.id === unitId);
    const pos = s ? mergeLineRects(this.charRects(block, s.start, s.end)) : [];
    this.unitCache.set(unitId, pos);
    return pos;
  }

  /**
   * Number of positioned characters on `pageIndex` that precede `first` in reading order.
   * Zotero's PDF sort index uses the character offset within the page.
   */
  pageOffset(block: Block, start: number): number {
    const first = this.charRects(block, start, block.text.length)[0];
    if (!first) return 0;
    this.pageOrder ??= this.indexPages();
    // Count characters of earlier text nodes on the same page, then within the node.
    for (const seg of block.segments) {
      if (start >= seg.start + seg.length) continue;
      const key = seg.nodePath.join(".");
      const base = this.pageOrder.get(`${key}@${first.pageIndex}`) ?? 0;
      const n = this.charsOf(seg.nodePath);
      if (!n) return base;
      const local = rectsForNodeRange(n.text, n.chars, 0, seg.nodeStart + Math.max(0, start - seg.start)) ?? [];
      return base + local.filter((c) => c.pageIndex === first.pageIndex).length;
    }
    return 0;
  }

  private indexPages(): Map<string, number> {
    const counts = new Map<number, number>();
    const out = new Map<string, number>();
    const walk = (node: any, path: number[]) => {
      if (isTextNode(node)) {
        const key = path.join(".");
        const chars = this.charsOf(path)?.chars ?? [];
        const pages = new Set(chars.map((c) => c.pageIndex));
        for (const p of pages) out.set(`${key}@${p}`, counts.get(p) ?? 0);
        for (const c of chars) counts.set(c.pageIndex, (counts.get(c.pageIndex) ?? 0) + 1);
        return;
      }
      (node.content ?? []).forEach((c: any, i: number) => walk(c, path.concat(i)));
    };
    this.sdt.content.forEach((b, i) => walk(b, [i]));
    return out;
  }

  /** Units whose line boxes overlap an annotation position by at least `minShare` of their area. */
  unitsAt(position: PagePosition, minShare = 0.3): string[] {
    const ids: string[] = [];
    const area = (r: number[]) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
    const inter = (a: number[], b: number[]) =>
      Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    for (const b of this.doc.blocks) {
      if (!b.sentences.length || !b.pageRects.some((r) => r[0] === position.pageIndex)) continue;
      for (const s of b.sentences) {
        const rects = this.unitPositions(b, s.id).find((p) => p.pageIndex === position.pageIndex)?.rects;
        if (!rects?.length) continue;
        const total = rects.reduce((n, r) => n + area(r), 0);
        let covered = 0;
        for (const r of rects) for (const q of position.rects) covered += inter(r, q);
        if (total > 0 && covered / total >= minShare) ids.push(s.id);
      }
    }
    return ids;
  }
}
