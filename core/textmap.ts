// Decoding of SDT `anchor.textMap` into per-character PDF rects.
// Format (structured-document-text src/pdf/decode.js): JSON array of runs
// [header, pageIndex, minX, minY, maxX, maxY, ...widths], one position per
// non-whitespace character; a width is either a number or [delta, width].

const HEADER_LAST_IS_SOFT_HYPHEN = 1 << 0;
const HEADER_AXIS_DIR_SHIFT = 1;

export interface CharRect {
  pageIndex: number;
  rect: [number, number, number, number];
}

export function decodeTextMap(textMap: string | undefined): CharRect[] {
  if (typeof textMap !== "string") return [];
  let runs: unknown;
  try {
    runs = JSON.parse(textMap);
  } catch {
    return [];
  }
  if (!Array.isArray(runs)) return [];
  const out: CharRect[] = [];
  for (const run of runs) {
    if (!Array.isArray(run) || run.length < 6) continue;
    const [header, pageIndex, minX, minY, maxX, maxY, ...widths] = run as any[];
    const axisDir = (header >> HEADER_AXIS_DIR_SHIFT) & 0b11;
    const vertical = axisDir === 1 || axisDir === 3;
    const startPos = vertical ? minY : minX;
    const endPos = vertical ? maxY : maxX;
    const positions: [number, number][] = [];
    if (widths.length === 0) {
      positions.push([startPos, endPos]);
    } else {
      let pos = startPos;
      for (const w of widths) {
        if (Array.isArray(w)) {
          pos += w[0];
          positions.push([pos, pos + w[1]]);
          pos += w[1];
        } else {
          positions.push([pos, pos + w]);
          pos += w;
        }
      }
    }
    if (header & HEADER_LAST_IS_SOFT_HYPHEN) positions.pop();
    for (const [a, b] of positions) {
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      out.push({
        pageIndex,
        rect: vertical ? [minX, a, maxX, b] : [a, minY, b, maxY],
      });
    }
  }
  return out;
}

/**
 * Map character offsets [start, end) of a text node to PDF rects. Whitespace has no
 * geometry, so non-whitespace characters consume CharRects in order.
 * Returns null when the node has no usable geometry.
 */
export function rectsForNodeRange(
  text: string,
  chars: CharRect[],
  start: number,
  end: number,
): CharRect[] | null {
  if (!chars.length) return null;
  const out: CharRect[] = [];
  let k = 0;
  for (let i = 0; i < text.length && k < chars.length; i++) {
    if (/\s/.test(text[i])) continue;
    if (i >= start && i < end) out.push(chars[k]);
    k++;
  }
  return out;
}

/** Merge character rects into line boxes per page. */
export function mergeLineRects(chars: CharRect[]): { pageIndex: number; rects: number[][] }[] {
  const byPage = new Map<number, number[][]>();
  for (const c of chars) {
    const lines = byPage.get(c.pageIndex) ?? [];
    const [x1, y1, x2, y2] = c.rect;
    const h = y2 - y1;
    const line = lines.find(
      (l) => Math.abs(l[1] - y1) < h * 0.5 && Math.abs(l[3] - y2) < h * 0.5 && x1 - l[2] < h * 2 && l[0] - x2 < h * 2,
    );
    if (line) {
      line[0] = Math.min(line[0], x1);
      line[1] = Math.min(line[1], y1);
      line[2] = Math.max(line[2], x2);
      line[3] = Math.max(line[3], y2);
    } else {
      lines.push([x1, y1, x2, y2]);
    }
    byPage.set(c.pageIndex, lines);
  }
  return [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([pageIndex, rects]) => ({ pageIndex, rects }));
}
