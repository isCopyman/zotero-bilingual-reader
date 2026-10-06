// Sentence segmentation for academic English. Returns [start, end) ranges over the input,
// trimmed of surrounding whitespace, so callers keep exact offsets into the source text.

const ABBREVIATIONS = new Set(
  [
    "al", "e.g", "i.e", "etc", "cf", "vs", "viz", "approx", "resp", "ca",
    "fig", "figs", "eq", "eqs", "ref", "refs", "sec", "secs", "tab", "tabs",
    "no", "nos", "vol", "vols", "pp", "p", "ch", "chap", "app", "appx", "alg",
    "thm", "def", "lem", "prop", "cor", "ex",
    "dr", "mr", "mrs", "ms", "prof", "st", "jr", "sr", "inc", "ltd", "co", "corp",
    "dept", "univ", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept",
    "oct", "nov", "dec", "u.s", "u.k", "ph.d", "m.sc", "b.sc",
  ].map((s) => s.toLowerCase()),
);

// Abbreviations that commonly end a sentence when followed by an uppercase word.
const TERMINAL_OK = new Set(["etc"]);

const CLOSERS = `"'”’)]}`;

export interface SentenceRange {
  start: number;
  end: number;
}

function wordBefore(text: string, dotIndex: number): string {
  let i = dotIndex - 1;
  while (i >= 0 && /[A-Za-z.]/.test(text[i])) i--;
  return text.slice(i + 1, dotIndex).toLowerCase();
}

function isBoundary(text: string, i: number): number {
  // i points at a terminal punctuation char. Returns end index (exclusive) of the sentence
  // if this is a boundary, or -1.
  const ch = text[i];
  let end = i + 1;
  // Absorb repeated terminals and closing quotes/brackets: "...).", '?"'
  while (end < text.length && (".!?".includes(text[end]) || CLOSERS.includes(text[end]))) end++;
  // Absorb trailing citation brackets like ". [12]" is NOT absorbed (citation usually precedes the dot).
  if (end >= text.length) return end;
  if (!/\s/.test(text[end])) return -1; // "3.14", "e.g.x", "U.S."
  // Look at the next non-space char.
  let j = end;
  while (j < text.length && /\s/.test(text[j])) j++;
  if (j >= text.length) return end;
  const next = text[j];

  if (ch === ".") {
    const word = wordBefore(text, i);
    if (word && ABBREVIATIONS.has(word.replace(/\.$/, ""))) {
      if (!(TERMINAL_OK.has(word) && /[A-Z]/.test(next))) return -1;
    }
    // Single-letter initial: "J. Smith", "A. Multi-Source"
    if (/^[a-z]$/.test(word) && /[A-Z]/.test(text[i - 1] ?? "")) return -1;
    // Numbered list markers / section numbers: "2. Methods" at block start, "Section 3. We"
    if (/\d/.test(text[i - 1] ?? "") && /^\d+$/.test(text.slice(Math.max(0, i - 4), i).trim()) && i < 6) return -1;
  }
  // A new sentence starts with an uppercase letter, a digit, an opening quote/bracket, or a symbol.
  if (/[a-z]/.test(next)) return -1;
  return end;
}

/** Inline math spans `$...$` (not `$$`), as written in MinerU text. */
export const INLINE_MATH = /\$(?!\$)((?:\\\$|[^$])+?)\$/g;

export function splitSentences(source: string, minLength = 6): SentenceRange[] {
  // Punctuation inside inline formulas never ends a sentence: blank it out (same length, so
  // offsets stay valid) before looking for boundaries.
  const text = source.includes("$") ? source.replace(INLINE_MATH, (m) => "$" + "x".repeat(m.length - 2) + "$") : source;
  const raw: SentenceRange[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    const end = isBoundary(text, i);
    if (end < 0) continue;
    raw.push({ start, end });
    start = end;
    i = end - 1;
  }
  if (start < text.length) raw.push({ start, end: text.length });

  // Trim whitespace while preserving offsets; drop empties.
  const trimmed = raw
    .map(({ start, end }) => {
      while (start < end && /\s/.test(text[start])) start++;
      while (end > start && /\s/.test(text[end - 1])) end--;
      return { start, end };
    })
    .filter((r) => r.end > r.start);

  // Merge fragments that are too short to stand alone (e.g. "(a)", "Fig. 2.") into a neighbour.
  const out: SentenceRange[] = [];
  for (const r of trimmed) {
    const prev = out[out.length - 1];
    if (prev && r.end - r.start < minLength) {
      prev.end = r.end;
    } else if (prev && prev.end - prev.start < minLength) {
      prev.end = r.end;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}
