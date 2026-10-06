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
      // The span may also hold formula glyphs MinerU has as LaTeX; its words must all be there, in order.
      let k = 0;
      for (const c of b) if (c === a[k]) k++;
      if (k >= a.length * 0.95 && b.length <= a.length * 1.6 + 20) good++;
    }
    expect(good / units.length).toBeGreaterThan(0.9);
  });
  it("lets a highlight reach across formulas at a sentence's edge", () => {
    // MinerU sentences opening or closing with inline math, matched to one Zotero sentence.
    const edge = units.filter((s) => /^\s*\$|\$[\s.,;:)]*$/.test(s.text) && al.toSdt.get(s.id)?.length === 1);
    const whole = edge.filter((s) => {
      const [p] = al.toSdt.get(s.id)!;
      const sent = sdtBlocks.get(p.blockId)!.sentences.find((x) => x.id === p.unitId)!;
      return p.start === sent.start && p.end === sent.end;
    });
    console.log(`formula-edged sentences reaching both ends: ${whole.length}/${edge.length}`);
    expect(edge.length).toBeGreaterThan(5);
    expect(whole.length / edge.length).toBeGreaterThan(0.8);
  });
  it("maps Zotero sentences (where PDF highlights live) back to MinerU ones", () => {
    const sdtUnits = base.blocks.filter((b) => b.translatable).flatMap((b) => b.sentences);
    const mapped = sdtUnits.filter((s) => al.toMineru.get(s.id)?.length).length;
    expect(mapped / sdtUnits.length).toBeGreaterThan(0.9);
  });
});
