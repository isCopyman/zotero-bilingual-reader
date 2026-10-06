import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDocument } from "../../core/build";
import { Locator } from "../../core/locate";

const sdt = JSON.parse(readFileSync(new URL("../fixtures/zhang2021.sdt.json", import.meta.url), "utf8"));
const doc = buildDocument(sdt, "4LW4ETNL");
const loc = new Locator(sdt, doc);
const body = doc.blocks.filter((b) => b.kind === "paragraph" && b.translatable && b.sentences.length > 2);

describe("Locator", () => {
  it("gives every body sentence line boxes inside its block", () => {
    for (const b of body.slice(0, 40)) {
      for (const s of b.sentences) {
        const pos = loc.unitPositions(b, s.id);
        expect(pos.length, s.text).toBeGreaterThan(0);
        for (const p of pos) {
          const frames = b.pageRects.filter((r) => r[0] === p.pageIndex);
          expect(frames.length).toBeGreaterThan(0);
          for (const r of p.rects) {
            expect(frames.some((f) => r[0] >= f[1] - 2 && r[2] <= f[3] + 2 && r[1] >= f[2] - 2 && r[3] <= f[4] + 2)).toBe(true);
          }
        }
      }
    }
  });
  it("maps a sentence's own position back to that sentence", () => {
    for (const b of body.slice(0, 20)) {
      const s = b.sentences[1];
      const [p] = loc.unitPositions(b, s.id);
      expect(loc.unitsAt(p)).toContain(s.id);
      expect(loc.unitsAt(p).length).toBeLessThanOrEqual(3);
    }
  });
  it("orders page offsets by reading order", () => {
    const b = body[3];
    const a = loc.pageOffset(b, b.sentences[0].start);
    const c = loc.pageOffset(b, b.sentences[2].start);
    expect(c).toBeGreaterThan(a);
  });
});
