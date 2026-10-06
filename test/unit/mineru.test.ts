import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDocument } from "../../core/build";
import { matchMineru } from "../../core/mineru";

const load = (f: string) => JSON.parse(readFileSync(new URL(`../fixtures/${f}`, import.meta.url), "utf8"));
const doc = buildDocument(load("zhang2021.sdt.json"), "TEST");

describe("table recovery", () => {
  it("synthesizes a table body under each TABLE caption that SDT left empty", () => {
    const tables = doc.blocks.filter((b) => b.kind === "table");
    expect(tables.map((b) => b.id)).toEqual(["27.t", "147.t", "156.t", "167.t"]);
    for (const t of tables) {
      const [, x1, y1, x2, y2] = t.pageRects[0];
      expect(x2 - x1).toBeGreaterThan(100);
      expect(y2 - y1).toBeGreaterThan(30);
    }
  });
});

describe("matchMineru", () => {
  const e = matchMineru(doc, load("zhang2021.mineru.json"));
  it("attaches LaTeX to every display-math block", () => {
    const math = doc.blocks.filter((b) => b.kind === "math");
    expect(math.every((b) => e[b.id]?.latex || e[b.id]?.coveredBy)).toBe(true);
    expect(e[math[0].id].latex).toMatch(/^P \(z/);
    expect(e[math[0].id].latex).not.toMatch(/\$\$/);
  });
  it("attaches HTML to every recovered table", () => {
    for (const id of ["27.t", "147.t", "156.t", "167.t"]) expect(e[id]?.tableHtml).toMatch(/^<table>/);
  });
});
