import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDocument } from "../../core/build";
import { makeBatches, parseResponse, type Batch } from "../../core/translate/protocol";
import { runBatch, type Engine } from "../../core/translate/runner";

const sdt = JSON.parse(readFileSync(new URL("../fixtures/zhang2021.sdt.json", import.meta.url), "utf8"));
const doc = buildDocument(sdt, "TEST");

const batch: Batch = {
  paragraphs: [{ blockId: "b", kind: "paragraph", fullText: "Wind power forecasting reduces reserve costs considerably [3]. It matters!", totalUnits: 2, units: [
    { id: "b:0", en: "Wind power forecasting reduces reserve costs considerably [3]." },
    { id: "b:1", en: "It matters!" },
  ] }],
  ids: ["b:0", "b:1"],
  chars: 70,
};

describe("makeBatches", () => {
  it("covers every translatable sentence exactly once and respects the budget", () => {
    const batches = makeBatches(doc.blocks, () => true, 2600, 45);
    const ids = batches.flatMap((b) => b.ids);
    const expected = doc.blocks.filter((b) => b.translatable).flatMap((b) => b.sentences.map((s) => s.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(expected.sort());
    for (const b of batches) if (b.paragraphs.length > 1) expect(b.ids.length).toBeLessThanOrEqual(45);
  });
  it("never splits a paragraph across batches", () => {
    const batches = makeBatches(doc.blocks, () => true, 500, 10);
    const owner = new Map<string, number>();
    batches.forEach((b, i) => b.paragraphs.forEach((p) => {
      expect(owner.has(p.blockId)).toBe(false);
      owner.set(p.blockId, i);
    }));
  });
});

describe("parseResponse", () => {
  it("accepts fenced JSON and bare arrays", () => {
    const r = parseResponse('```json\n{"translations":[{"id":"b:0","zh":"风电预测可显著降低备用成本 [3]。"},{"id":"b:1","zh":"这很重要！"}]}\n```', batch);
    expect(r.missing).toEqual([]);
    const r2 = parseResponse('Sure: [{"id":"b:0","zh":"甲［3］。"},{"id":"b:1","zh":"乙。"}]', batch);
    expect(Object.keys(r2.ok)).toEqual(["b:0", "b:1"]);
  });
  it("flags missing, duplicate, unexpected and untranslated items", () => {
    const r = parseResponse(JSON.stringify({ translations: [
      { id: "b:0", zh: "Wind power forecasting reduces reserve costs considerably [3]." },
      { id: "x:9", zh: "多余" },
    ] }), batch);
    expect(r.ok).toEqual({});
    expect(r.missing.sort()).toEqual(["b:0", "b:1"]);
    expect(r.problems.join()).toMatch(/not translated in b:0/);
    expect(r.problems.join()).toMatch(/unexpected id x:9/);
    const d = parseResponse(JSON.stringify({ translations: [{ id: "b:1", zh: "甲" }, { id: "b:1", zh: "乙" }] }), batch);
    expect(d.missing).toContain("b:1");
  });
});

describe("runBatch", () => {
  it("rejects translations that drop citation markers", () => {
    const r = parseResponse(JSON.stringify({ translations: [{ id: "b:0", zh: "风电预测可显著降低备用成本。" }, { id: "b:1", zh: "这很重要！" }] }), batch);
    expect(r.missing).toEqual(["b:0"]);
    expect(r.problems.join()).toMatch(/lost citation \[3\]/);
  });

  it("keeps the whole paragraph as context when re-asking a subset", async () => {
    const prompts: string[] = [];
    const engine: Engine = {
      id: "fake",
      label: "fake",
      async complete(p) {
        prompts.push(p.user);
        const ids = [...p.user.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]);
        return JSON.stringify({ translations: ids.slice(0, prompts.length === 1 ? 1 : undefined).map((id) => ({ id, zh: `译 [3] ${id}` })) });
      },
    };
    await runBatch(engine, batch, {});
    expect(prompts[0]).not.toContain('"context"');
    expect(prompts[1]).toContain('"context":"Wind power forecasting reduces reserve costs considerably [3]. It matters!"');
  });

  it("re-asks only for missing ids", async () => {
    const seen: string[][] = [];
    const engine: Engine = {
      id: "fake",
      label: "fake",
      async complete(p) {
        const ids = [...p.user.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]);
        seen.push(ids);
        // First call drops the second sentence.
        return JSON.stringify({ translations: ids.slice(0, seen.length === 1 ? 1 : undefined).map((id) => ({ id, zh: `译 [3] ${id}` })) });
      },
    };
    const r = await runBatch(engine, batch, {});
    expect(r.failed).toEqual([]);
    expect(seen).toEqual([["b:0", "b:1"], ["b:1"]]);
  });
});
