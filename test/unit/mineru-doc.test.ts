import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDocument } from "../../core/build";
import { buildMineruDocument } from "../../core/mineru-doc";
import { lostMath } from "../../core/translate/protocol";

const sdt = JSON.parse(readFileSync(new URL("../fixtures/zhang2021.sdt.json", import.meta.url), "utf8"));
const items = JSON.parse(readFileSync(new URL("../fixtures/zhang2021.mineru.json", import.meta.url), "utf8"));
const base = buildDocument(sdt, "4LW4ETNL");
const doc = buildMineruDocument(items, base, "4LW4ETNL");

describe("MinerU document", () => {
  it("keeps body structure and drops running headers, footers and page numbers", () => {
    const kinds = (k: string) => doc.blocks.filter((b) => b.kind === k).length;
    expect(kinds("heading")).toBeGreaterThan(20);
    expect(kinds("math")).toBe(28);
    expect(kinds("table")).toBe(4);
    expect(kinds("image")).toBe(21);
    expect(doc.blocks.some((b) => /IEEE TRANSACTIONS ON SUSTAINABLE ENERGY, VOL/.test(b.text))).toBe(false);
    expect(doc.blocks.some((b) => b.text === "2205")).toBe(false);
  });
  it("carries LaTeX and table HTML, and numbers headings by depth", () => {
    expect(doc.blocks.filter((b) => b.kind === "math").every((b) => b.mineru?.latex && !b.mineru.latex.startsWith("$$"))).toBe(true);
    expect(doc.blocks.filter((b) => b.kind === "table").every((b) => /<table/.test(b.mineru?.tableHtml ?? ""))).toBe(true);
    expect(doc.blocks.find((b) => b.text.startsWith("II. "))?.level).toBe(1);
    expect(doc.blocks.find((b) => b.text.startsWith("A. "))?.level).toBe(2);
  });
  it("does not glue the author line onto the abstract", () => {
    const authors = doc.blocks.find((b) => b.text.startsWith("Hao Zhang"))!;
    expect(authors.text).not.toMatch(/Abstract/);
  });
  it("never splits a sentence inside an inline formula", () => {
    const withMath = doc.blocks.filter((b) => b.inlineMath && b.sentences.length);
    expect(withMath.length).toBeGreaterThan(10);
    for (const b of withMath) for (const s of b.sentences) expect((s.text.replace(/\\\$/g, "").match(/\$/g) ?? []).length % 2, s.text).toBe(0);
  });
  it("maps MinerU boxes into PDF space on the right page", () => {
    const eq = doc.blocks.find((b) => b.kind === "math")!;
    const [p, x1, y1, x2, y2] = eq.pageRects[0];
    expect(p).toBe(3);
    expect(x2).toBeGreaterThan(x1);
    expect(y2).toBeGreaterThan(y1);
    expect(y2).toBeLessThanOrEqual(base.pages[p].height);
  });
});

describe("inline math check", () => {
  it("reports formulas missing from the translation", () => {
    expect(lostMath("the input $x_t$ and $[1]$", "输入 $x _ t$ 与 $[1]$")).toEqual([]);
    expect(lostMath("the input $x_t$ and $[1]$", "输入 x_t 与 $[1]$")).toEqual(["$x_t$"]);
  });
});
