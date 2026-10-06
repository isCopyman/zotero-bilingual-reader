// Text alignment between the MinerU document and the Zotero (SDT) document of the same PDF.
// Only the SDT text knows where each character sits on the page, so this is what lets the MinerU
// source show PDF highlights, create them and locate sentences in the PDF.
//
// Both texts are reduced to lowercase letters and digits (inline LaTeX of MinerU dropped: SDT has
// the formula as loose glyphs instead). Character runs are matched from 12-character grams that
// occur exactly once in each text, then extended in both directions while the characters agree.
// Reading order is not assumed to be the same (floats and footnotes move between parsers).

import type { ZbrDocument } from "./model";

/** A range of an SDT sentence, as offsets into its block's text. */
export interface SdtSpan {
  unitId: string;
  blockId: string;
  start: number;
  end: number;
}

export interface Alignment {
  /** MinerU unit -> the SDT text it corresponds to, in SDT reading order. */
  toSdt: Map<string, SdtSpan[]>;
  /** SDT unit -> MinerU units that mostly correspond to it. */
  toMineru: Map<string, string[]>;
}

interface Stream {
  text: string;
  /** Per kept character: index into `units`, and offset in the block text. */
  unit: Int32Array;
  offset: Int32Array;
  units: { id: string; blockId: string }[];
}

const K = 12;
const KEEP = /[a-z0-9]/;

function stream(doc: ZbrDocument, dropMath: boolean): Stream {
  const chars: string[] = [];
  const unit: number[] = [];
  const offset: number[] = [];
  const units: Stream["units"] = [];
  for (const b of doc.blocks) {
    if (!b.sentences.length) continue;
    const math: [number, number][] = [];
    if (dropMath) for (const m of b.text.matchAll(/\$[^$]+\$/g)) math.push([m.index!, m.index! + m[0].length]);
    for (const s of b.sentences) {
      const u = units.push({ id: s.id, blockId: b.id }) - 1;
      for (let i = s.start; i < s.end; i++) {
        if (math.some(([a, z]) => i >= a && i < z)) continue;
        const c = b.text[i].toLowerCase();
        if (!KEEP.test(c)) continue;
        chars.push(c);
        unit.push(u);
        offset.push(i);
      }
    }
  }
  return { text: chars.join(""), unit: Int32Array.from(unit), offset: Int32Array.from(offset), units };
}

/** Grams occurring exactly once: gram -> position. */
function uniqueGrams(text: string): Map<string, number> {
  const seen = new Map<string, number>();
  for (let i = 0; i + K <= text.length; i++) {
    const g = text.slice(i, i + K);
    seen.set(g, seen.has(g) ? -1 : i);
  }
  return seen;
}

/** For each MinerU character, the SDT character it matches, or -1. */
function matchChars(m: string, s: string): Int32Array {
  const map = new Int32Array(m.length).fill(-1);
  const used = new Uint8Array(s.length);
  const sg = uniqueGrams(s);
  const mg = uniqueGrams(m);
  for (let i = 0; i + K <= m.length; i++) {
    if (map[i] >= 0) continue;
    const g = m.slice(i, i + K);
    if (mg.get(g) !== i) continue;
    const j = sg.get(g);
    if (j === undefined || j < 0 || used[j]) continue;
    // Extend backwards over what the gram itself could not anchor, then forwards.
    let a = i;
    let b = j;
    while (a > 0 && b > 0 && map[a - 1] < 0 && !used[b - 1] && m[a - 1] === s[b - 1]) {
      a--;
      b--;
    }
    while (a < m.length && b < s.length && map[a] < 0 && !used[b] && m[a] === s[b]) {
      map[a] = b;
      used[b] = 1;
      a++;
      b++;
    }
  }
  return map;
}

export function alignDocuments(sdt: ZbrDocument, mineru: ZbrDocument): Alignment {
  const S = stream(sdt, false);
  const M = stream(mineru, true);
  const map = matchChars(M.text, S.text);

  // MinerU unit -> SDT unit -> [count, min offset, max offset].
  const pairs = new Map<number, Map<number, [number, number, number]>>();
  for (let i = 0; i < map.length; i++) {
    const j = map[i];
    if (j < 0) continue;
    const mu = M.unit[i];
    const su = S.unit[j];
    let row = pairs.get(mu);
    if (!row) pairs.set(mu, (row = new Map()));
    const o = S.offset[j];
    const cell = row.get(su);
    if (cell) {
      cell[0]++;
      cell[1] = Math.min(cell[1], o);
      cell[2] = Math.max(cell[2], o);
    } else row.set(su, [1, o, o]);
  }

  const sdtLen = new Int32Array(S.units.length);
  for (let j = 0; j < S.unit.length; j++) sdtLen[S.unit[j]]++;

  const toSdt = new Map<string, SdtSpan[]>();
  const toMineru = new Map<string, string[]>();
  for (const [mu, row] of pairs) {
    const total = [...row.values()].reduce((n, c) => n + c[0], 0);
    const spans: SdtSpan[] = [];
    for (const [su, [count, lo, hi]] of [...row].sort((a, b) => a[0] - b[0])) {
      // A few stray characters are noise (a shared word matched across sentences).
      if (count < Math.min(8, total / 2)) continue;
      const { id, blockId } = S.units[su];
      spans.push({ unitId: id, blockId, start: lo, end: hi + 1 });
      if (count >= total / 2 || count >= sdtLen[su] / 2) {
        const list = toMineru.get(id) ?? [];
        list.push(M.units[mu].id);
        toMineru.set(id, list);
      }
    }
    if (spans.length) toSdt.set(M.units[mu].id, spans);
  }
  return { toSdt, toMineru };
}
