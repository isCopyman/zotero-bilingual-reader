import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDocument } from "../../core/build";
import { checkUnit } from "../../core/translate/protocol";
import { glossaryPrompt, mergeGlossaries, parseGlossary } from "../../core/translate/glossary";
import { buildUnitsFile, collect, expectedUnits, fixText, handoffPhase, startCommands, startPrompt, taskText } from "../../core/translate/whole";

const sdt = JSON.parse(readFileSync(new URL("../fixtures/zhang2021.sdt.json", import.meta.url), "utf8"));
const doc = buildDocument(sdt, "TEST");
const all = doc.blocks.filter((b) => b.translatable).flatMap((b) => b.sentences);

describe("checkUnit", () => {
  it("treats dollar signs as currency unless the source marks inline math", () => {
    const en = "The price is about 0.078 $/kWh, or 105 $ per month.";
    const zh = "电价约为 0.078 美元/kWh，即每月 105 美元。";
    expect(checkUnit(en, zh)).toBeNull();
    expect(checkUnit("Let $x_t$ be the power output.", "设功率输出为 x。", true)).toMatch(/lost inline math/);
    expect(checkUnit("Let $x_t$ be the power output.", "设 $x_t$ 为功率输出。", true)).toBeNull();
  });
  it("rejects lost citations and untranslated sentences", () => {
    expect(checkUnit("Forecasting reduces reserve costs considerably [3].", "预测能显著降低备用成本。")).toMatch(/lost citation/);
    expect(checkUnit("Forecasting reduces reserve costs considerably.", "Forecasting reduces reserve costs considerably.")).toBe("not translated");
    expect(checkUnit("ξ ∈ R d", "ξ ∈ R d")).toBeNull();
  });
  it("leaves author lines in English, with ORCID badges and escaped footnote marks", () => {
    for (const en of ["Mingyuan Zhang, Feifan Zhang iD \\*", "Evangelos Spiliotis $^{ID}$ \\*, Evangelos Theodorou", "Hao Zhang, Jie Yan, Yongqian Liu and Li Li"]) {
      expect(checkUnit(en, en)).toBeNull();
    }
  });
});

describe("whole-paper task files", () => {
  it("lists every sentence once, with existing translations only outside the todo set", () => {
    const todo = new Set(all.slice(10).map((s) => s.id));
    const cached = new Map(all.slice(0, 10).map((s) => [s.hash, `译文${s.id}`]));
    const file = buildUnitsFile(doc, todo, (h) => cached.get(h));
    const units = file.sections.flatMap((s) => s.paragraphs.flatMap((p) => p.units));
    expect(units.map((u) => u.id)).toEqual(all.map((s) => s.id));
    expect(units.filter((u) => u.zh).length).toBe(10);
    expect(units.filter((u) => !u.zh).every((u) => todo.has(u.id))).toBe(true);
    expect(file.todo).toBe(todo.size);
  });
  it("collects part files, later files winning, and checks each sentence", () => {
    const [a, b, c] = all.filter((s) => !/\[\d/.test(s.text) && s.text.length > 40);
    const expected = expectedUnits(doc, new Set([a.id, b.id, c.id]));
    const r = collect(
      [
        { [a.id]: "第一句。", [b.id]: b.text, other: "不在任务里" },
        null,
        { translations: [{ id: b.id, zh: "第二句。" }] },
      ],
      expected,
    );
    expect(r.ok).toEqual({ [a.id]: "第一句。", [b.id]: "第二句。" });
    expect(r.bad).toEqual({});
    expect(collect([{ [c.id]: c.text }], expected).bad[c.id]).toBe("not translated");
  });
  it("task text asks for the field's own style and carries the user's glossary", () => {
    const t = taskText({ dir: "C:/jobs/1-ABC", title: "T", glossary: "wind farm = 风电场", todo: 5, partial: true, math: true });
    expect(t).toContain("C:/jobs/1-ABC");
    expect(t).not.toMatch(/当前目录/);
    expect(t).toMatch(/所属领域的中文学术期刊/);
    expect(t).not.toMatch(/学报|电力系统自动化/);
    expect(t).toMatch(/wind farm = 风电场/);
    expect(t).toMatch(/\$\.\.\.\$/);
    expect(t).toMatch(/parts\//);
    expect(fixText(3, "C:/jobs/1-ABC")).toMatch(/fix_out\.json/);
  });
  it("judges the agent's phase from its files only", () => {
    expect(handoffPhase({ glossary: false, delivered: 0, todo: 10, report: false })).toBe("waiting");
    expect(handoffPhase({ glossary: true, delivered: 0, todo: 10, report: false })).toBe("glossary");
    expect(handoffPhase({ glossary: true, delivered: 4, todo: 10, report: false })).toBe("translating");
    expect(handoffPhase({ glossary: true, delivered: 10, todo: 10, report: false })).toBe("checking");
    expect(handoffPhase({ glossary: true, delivered: 10, todo: 10, report: true })).toBe("done");
    const cmds = startCommands("C:\\Users\\o'neil\\jobs\\1-A");
    expect(cmds.map((c) => c.tool)).toEqual(["Grok Build", "Codex CLI", "Claude Code"]);
    expect(cmds[0].line).toContain("'C:\\Users\\o''neil\\jobs\\1-A'");
    expect(startPrompt("D:\\x")).toContain("D:\\x");
  });
});

describe("checkUnit false positives seen in live runs", () => {
  it("accepts author lists kept in English", () => {
    const en = "Zhihao Shang $^{a}$ , Yanhua Chen $^{b,*}$ , Daokai Lai $^{b}$ , Min Li $^{c}$ , Yi Yang $^{c}$";
    expect(checkUnit(en, en, true)).toBeNull();
    expect(checkUnit("Mao Yang, Yutong Huang, Bo Wang, Chuanyu Xu, Mahmood Hosseini Imani, Tao Huang", "Mao Yang, Yutong Huang, Bo Wang, Chuanyu Xu, Mahmood Hosseini Imani, Tao Huang")).toBeNull();
    expect(checkUnit("Lei Liu $^{1,\\dagger}$ , Qi Wang $^{1,\\dagger}$ Hongwei Zhao $^{1,\\star}$ , Ruibo Guo $^{1}$", "Lei Liu $^{1,\\dagger}$ , Qi Wang $^{1,\\dagger}$ Hongwei Zhao $^{1,\\star}$ , Ruibo Guo $^{1}$", true)).toBeNull();
    // A real sentence is still caught.
    expect(checkUnit("Wind power forecasting reduces the reserve costs.", "Wind power forecasting reduces the reserve costs.")).toBe("not translated");
  });
  it("accepts symbol-only units and intervals that look like [01]", () => {
    expect(checkUnit("ξwind,i t ∈ Rdmodel , ξother,i t ∈ Rdmodel .", "ξwind,i t ∈ Rdmodel ，ξother,i t ∈ Rdmodel 。")).toBeNull();
    expect(checkUnit("The output lies in [01] for all quantiles considered here.", "输出取值于 [0,1]。")).toBeNull();
  });
});

describe("paper glossary", () => {
  it("asks about the paper's opening and parses the answer", () => {
    const p = glossaryPrompt(doc);
    expect(p.user).toContain("Headings:");
    expect(p.user.length).toBeLessThan(6000);
    expect(p.system).toMatch(/JSON/);
    const text = parseGlossary('```json\n{"terms":[{"en":"numerical weather prediction","zh":"数值天气预报"},{"en":"","zh":"x"},{"en":"MSTAN","zh":"MSTAN"}]}\n```');
    expect(text.split("\n")).toEqual(["numerical weather prediction = 数值天气预报", "MSTAN = MSTAN"]);
    expect(parseGlossary("sorry, no")).toBe("");
  });
  it("lets the reader's glossary win for the same term", () => {
    const merged = mergeGlossaries("Wind farm = 风场", "wind farm = 风电场\nresidual module = 残差模块");
    expect(merged.split("\n")).toEqual(["Wind farm = 风场", "residual module = 残差模块"]);
  });
});
