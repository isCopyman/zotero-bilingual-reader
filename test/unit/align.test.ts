import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { alignDocuments } from "../../core/align";
import { buildDocument } from "../../core/build";
import { buildMineruDocument } from "../../core/mineru-doc";

const sdt = JSON.parse(readFileSync(new URL("../fixtures/zhang2021.sdt.json", import.meta.url), "utf8"));
const items = JSON.parse(readFileSync(new URL("../fixtures/zhang2021.mineru.json", import.meta.url), "utf8"));
const base = buildDocument(sdt, "4LW4ETNL");
const doc = buildMineruDocument(items, base, "4LW4ETNL");
const t0 = performance.now();
const al = alignDocuments(base, doc);
const ms = performance.now() - t0;
const sdtBlocks = new Map(base.blocks.map((b) => [b.id, b]));
const letters = (s: string) => s.toLowerCase().replace(/\$[^$]+\$/g, "").replace(/[^a-z0-9]/g, "");

describe("MinerU <-> Zotero text alignment", () => {
  const units = doc.blocks.filter((b) => b.translatable).flatMap((b) => b.sentences);
  it("maps nearly every MinerU sentence onto Zotero text, quickly", () => {
    const mapped = units.filter((s) => al.toSdt.has(s.id)).length;
    console.log(`aligned ${mapped}/${units.length} in ${ms.toFixed(0)} ms`);
    expect(mapped / units.length).toBeGreaterThan(0.95);
    expect(ms).toBeLessThan(1500);
  });
  it("maps a sentence onto the same words", () => {
    let good = 0;
    for (const s of units) {
      const spans = al.toSdt.get(s.id);
      if (!spans) continue;
      const text = spans.map((p) => sdtBlocks.get(p.blockId)!.text.slice(p.start, p.end)).join(" ");
      const a = letters(s.text);
      const b = letters(text);
      if (Math.abs(a.length - b.length) <= Math.max(6, a.length * 0.1)) good++;
    }
    expect(good / units.length).toBeGreaterThan(0.9);
  });
  it("maps Zotero sentences (where PDF highlights live) back to MinerU ones", () => {
    const sdtUnits = base.blocks.filter((b) => b.translatable).flatMap((b) => b.sentences);
    const mapped = sdtUnits.filter((s) => al.toMineru.get(s.id)?.length).length;
    expect(mapped / sdtUnits.length).toBeGreaterThan(0.9);
  });
});
