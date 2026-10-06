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
  units: { id: string; blockId: string; start: number; end: number; mathStart: boolean; mathEnd: boolean }[];
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
      const inMath = (i: number) => math.some(([a, z]) => i >= a && i < z);
      const t = b.text.slice(s.start, s.end);
      const lead = s.start + (t.length - t.trimStart().length);
      const tail = s.start + t.replace(/[\s.,;:!?)\]]+$/, "").length - 1;
      const u = units.push({ id: s.id, blockId: b.id, start: s.start, end: s.end, mathStart: inMath(lead), mathEnd: inMath(tail) }) - 1;
      for (let i = s.start; i < s.end; i++) {
        if (inMath(i)) continue;
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

/** For each MinerU character the SDT character it matches, and the reverse; -1 for none. */
function matchChars(m: string, s: string): { map: Int32Array; back: Int32Array } {
  const map = new Int32Array(m.length).fill(-1);
  const back = new Int32Array(s.length).fill(-1);
  const sg = uniqueGrams(s);
  const mg = uniqueGrams(m);
  for (let i = 0; i + K <= m.length; i++) {
    if (map[i] >= 0) continue;
    const g = m.slice(i, i + K);
    if (mg.get(g) !== i) continue;
    const j = sg.get(g);
    if (j === undefined || j < 0 || back[j] >= 0) continue;
    // Extend backwards over what the gram itself could not anchor, then forwards.
    let a = i;
    let b = j;
    while (a > 0 && b > 0 && map[a - 1] < 0 && back[b - 1] < 0 && m[a - 1] === s[b - 1]) {
      a--;
      b--;
    }
    while (a < m.length && b < s.length && map[a] < 0 && back[b] < 0 && m[a] === s[b]) {
      map[a] = b;
      back[b] = a;
      a++;
      b++;
    }
  }
  return { map, back };
}

export function alignDocuments(sdt: ZbrDocument, mineru: ZbrDocument): Alignment {
  const S = stream(sdt, false);
  const M = stream(mineru, true);
  const { map, back } = matchChars(M.text, S.text);
  const takenByOther = (j: number, mu: number) => back[j] >= 0 && M.unit[back[j]] !== mu;
  // Stream range [first, last] of each SDT unit's kept characters.
  const first = new Int32Array(S.units.length).fill(-1);
  const last = new Int32Array(S.units.length).fill(-1);
  for (let j = 0; j < S.unit.length; j++) {
    if (first[S.unit[j]] < 0) first[S.unit[j]] = j;
    last[S.unit[j]] = j;
  }
  /**
   * Unmatched SDT characters of a unit before offset `lo` (or after `hi`), or -1 when another
   * MinerU sentence already took some of them. Used to let a span reach its sentence boundary
   * across a formula (SDT has it as loose glyphs that match nothing) or a few odd characters.
   */
  // A match run may run a letter or two past a sentence end (SDT keeps formula glyphs such as
  // "t" that MinerU has as LaTeX, and the next sentence may start with one): tolerated.
  const free = (js: Iterable<number>, mu: number) => {
    let n = 0;
    let taken = 0;
    for (const j of js) {
      if (takenByOther(j, mu) && ++taken > 2) return -1;
      n++;
    }
    return n;
  };
  function* range(from: number, to: number, keep: (j: number) => boolean) {
    const step = from <= to ? 1 : -1;
    for (let j = from; j >= 0 && (step > 0 ? j <= to : j >= to) && keep(j); j += step) yield j;
  }
  const freeBefore = (su: number, mu: number, lo: number) => free(range(first[su], last[su], (j) => S.offset[j] < lo), mu);
  const freeAfter = (su: number, mu: number, hi: number) => free(range(last[su], first[su], (j) => S.offset[j] > hi), mu);

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
    // A few stray characters are noise (a shared word matched across sentences).
    const kept = [...row].sort((a, b) => a[0] - b[0]).filter(([, [count]]) => count >= Math.min(8, total / 2));
    kept.forEach(([su, [count, lo, hi]], k) => {
      const { id, blockId, start, end } = S.units[su];
      // A formula opening (closing) the MinerU sentence only stretches its first (last) span.
      const mathStart = k === 0 && M.units[mu].mathStart;
      const mathEnd = k === kept.length - 1 && M.units[mu].mathEnd;
      const before = freeBefore(su, mu, lo);
      const after = freeAfter(su, mu, hi);
      const from = before >= 0 && (before <= 12 || mathStart) ? start : lo;
      const to = after >= 0 && (after <= 12 || mathEnd) ? end : hi + 1;
      spans.push({ unitId: id, blockId, start: from, end: to });
      if (count >= total / 2 || count >= sdtLen[su] / 2) {
        const list = toMineru.get(id) ?? [];
        list.push(M.units[mu].id);
        toMineru.set(id, list);
      }
    });
    if (spans.length) toSdt.set(M.units[mu].id, spans);
  }
  // Sentences with no letters outside LaTeX (a line of formulas) match nothing: they take the
  // Zotero text between their neighbours, when both neighbours sit in the same Zotero block.
  const sdtBlocks = new Map(sdt.blocks.map((b) => [b.id, b]));
  const ids = M.units.map((u) => u.id);
  for (let k = 0; k < ids.length; k++) {
    if (toSdt.has(ids[k])) continue;
    let p = k - 1;
    while (p >= 0 && !toSdt.has(ids[p])) p--;
    let n = k + 1;
    while (n < ids.length && !toSdt.has(ids[n])) n++;
    if (p < 0 || n >= ids.length) continue;
    const prev = toSdt.get(ids[p])!.at(-1)!;
    const next = toSdt.get(ids[n])![0];
    const block = sdtBlocks.get(prev.blockId);
    if (!block || next.blockId !== prev.blockId || next.start - prev.end > 400) continue;
    const spans: SdtSpan[] = [];
    for (const s of block.sentences) {
      const from = Math.max(s.start, prev.end);
      const to = Math.min(s.end, next.start);
      if (block.text.slice(from, to).trim()) spans.push({ unitId: s.id, blockId: block.id, start: from, end: to });
    }
    if (spans.length) toSdt.set(ids[k], spans);
  }
  return { toSdt, toMineru };
}
