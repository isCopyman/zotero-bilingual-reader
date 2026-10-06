// cyrb53: fast, deterministic 53-bit string hash usable in Zotero, browsers and Node.
export function hash53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(36).padStart(11, "0");
}

/** Hash of normalized text: whitespace-insensitive so re-parses with spacing changes still match. */
export function textHash(text: string): string {
  return hash53(text.replace(/\s+/g, " ").trim());
}

/**
 * Key under which the same sentence from the two sources (Zotero text, MinerU) is recognised:
 * letters and digits only, so quotes (' ’), list bullets, hyphens Zotero drops at line ends and
 * spacing do not matter; a leading "Table 1" / "Fig. 2" label is ignored. Sentences with inline
 * LaTeX get none: their formulas differ in kind between the sources, and so do translations.
 */
export function looseKey(text: string): string | null {
  if (text.includes("$")) return null;
  const k = text
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/^(table|fig|figure)\d+/, "");
  return k.length >= 6 ? k : null;
}
