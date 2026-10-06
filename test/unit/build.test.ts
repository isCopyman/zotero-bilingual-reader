import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDocument } from "../../core/build";
import { decodeTextMap, rectsForNodeRange } from "../../core/textmap";

const sdt = JSON.parse(readFileSync(new URL("../fixtures/zhang2021.sdt.json", import.meta.url), "utf8"));
const doc = buildDocument(sdt, "4LW4ETNL");

function nodeAt(path: number[]): any {
  let n: any = { content: sdt.content };
  for (const i of path) n = n.content[i];
  return n;
}

describe("buildDocument on Zhang 2021", () => {
  it("drops running headers/footers", () => {
    expect(doc.blocks.some((b) => /IEEE TRANSACTIONS/.test(b.text) && b.kind === "paragraph" && b.text.length < 80)).toBe(false);
    expect(doc.blocks.some((b) => /Authorized licensed use/.test(b.text))).toBe(false);
  });
  it("merges the drop cap into the first paragraph", () => {
    const p = doc.blocks.find((b) => b.text.includes("integration of high penetration wind energy"))!;
    expect(p.text.startsWith("WITH the integration")).toBe(true);
    expect(doc.blocks.some((b) => b.kind === "heading" && b.text.trim() === "W")).toBe(false);
  });
  it("merges part chains across columns", () => {
    const b = doc.blocks.find((x) => x.id === "17")!;
    expect(b.parts.map((p) => p.join("."))).toEqual(["17", "18"]);
    expect(doc.blocks.some((x) => x.id === "18")).toBe(false);
  });
  it("segments map back to exact node text", () => {
    for (const b of doc.blocks) {
      for (const s of b.segments) {
        const node = nodeAt(s.nodePath);
        expect(b.text.slice(s.start, s.start + s.length)).toBe(node.text.slice(s.nodeStart, s.nodeStart + s.length));
      }
    }
  });
  it("sentences cover translatable text and have stable ids", () => {
    const body = doc.blocks.filter((b) => b.translatable);
    expect(body.length).toBeGreaterThan(100);
    for (const b of body) {
      expect(b.sentences.length).toBeGreaterThan(0);
      for (const s of b.sentences) expect(b.text.slice(s.start, s.end)).toBe(s.text);
    }
    const again = buildDocument(sdt, "4LW4ETNL");
    expect(again.blocks.flatMap((b) => b.sentences.map((s) => s.id + s.hash))).toEqual(
      doc.blocks.flatMap((b) => b.sentences.map((s) => s.id + s.hash)),
    );
  });
  it("text nodes decode to one rect per non-whitespace char", () => {
    const b = doc.blocks.find((x) => x.translatable && x.kind === "paragraph")!;
    const seg = b.segments[0];
    const node = nodeAt(seg.nodePath);
    const chars = decodeTextMap(node.anchor?.textMap);
    const nonWs = [...node.text].filter((c: string) => !/\s/.test(c)).length;
    expect(chars.length).toBe(nonWs);
    expect(rectsForNodeRange(node.text, chars, 0, 5)!.length).toBe(node.text.slice(0, 5).replace(/\s/g, "").length);
  });
});

describe("front matter", () => {
  it("marks submission, affiliation, DOI and copyright lines as untranslated footnotes", () => {
    const notes = doc.blocks.filter((b) => b.role === "footnote");
    expect(notes.map((b) => b.text.slice(0, 20))).toHaveLength(10);
    expect(notes.every((b) => !b.translatable)).toBe(true);
    expect(notes.some((b) => /^Manuscript received/.test(b.text))).toBe(true);
    // Body paragraphs, captions and references are untouched.
    expect(notes.every((b) => b.pageRects[0][0] === 0)).toBe(true);
  });
});

describe("paragraphs split by column or page breaks", () => {
  it("joins the halves into one block and one sentence", () => {
    const b = doc.blocks.find((x) => x.text.includes("can be divided into physical models"))!;
    expect(b).toBeTruthy();
    expect(b.sentences.some((s) => /can be divided into physical models/.test(s.text))).toBe(true);
    expect(new Set(b.pageRects.map((r) => r[0])).size).toBe(2);
  });
  it("keeps text before and after display equations apart", () => {
    const i = doc.blocks.findIndex((x) => x.kind === "math");
    expect(doc.blocks[i - 1].kind).not.toBe("math");
    expect(doc.blocks.some((x) => x.kind === "paragraph" && /^\s*where\b/.test(x.text))).toBe(true);
  });
});
