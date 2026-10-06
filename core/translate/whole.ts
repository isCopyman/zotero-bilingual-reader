// Whole-paper mode: an agent receives the entire paper as numbered sentences in a working
// directory and translates it as one long task (its own reading, glossary, subagents, self-check).
// It writes JSON files that the host polls and checks sentence by sentence. Runtime-agnostic.

import type { ZbrDocument } from "../model";
import { checkUnit } from "./protocol";

export interface TaskUnit {
  id: string;
  en: string;
  /** Existing translation, given for consistency; the agent leaves these alone. */
  zh?: string;
}

export interface TaskSection {
  heading: string;
  paragraphs: { block: string; kind: string; units: TaskUnit[] }[];
}

export interface UnitsFile {
  title?: string;
  source: string;
  /** Number of sentences without `zh`, i.e. to translate. */
  todo: number;
  sections: TaskSection[];
}

export interface Expected {
  en: string;
  hash: string;
  /** Source carries inline LaTeX as `$…$`. */
  math: boolean;
}

/** Files the agent writes: progressive parts, the final result, and the answer to a fix task. */
export const PARTS_DIR = "parts";
export const RESULT_FILE = "translations.json";
export const FIX_FILE = "fix.json";
export const FIX_RESULT_FILE = "fix_out.json";

/** Sentences of the paper by section; `todo` ids are to be translated, `cached` supplies the others. */
export function buildUnitsFile(doc: ZbrDocument, todo: Set<string>, cached: (hash: string) => string | undefined): UnitsFile {
  const sections: TaskSection[] = [{ heading: "(front matter)", paragraphs: [] }];
  for (const b of doc.blocks) {
    if (b.kind === "heading" && b.level === 1) sections.push({ heading: b.text, paragraphs: [] });
    if (!b.translatable || !b.sentences.length) continue;
    const units = b.sentences.map((s): TaskUnit => {
      const zh = todo.has(s.id) ? undefined : cached(s.hash);
      return zh ? { id: s.id, en: s.text, zh } : { id: s.id, en: s.text };
    });
    sections.at(-1)!.paragraphs.push({ block: b.id, kind: b.kind, units });
  }
  return { title: doc.title, source: doc.parser.kind, todo: todo.size, sections: sections.filter((s) => s.paragraphs.length) };
}

export function expectedUnits(doc: ZbrDocument, todo: Set<string>): Map<string, Expected> {
  const out = new Map<string, Expected>();
  for (const b of doc.blocks)
    for (const s of b.sentences) if (todo.has(s.id)) out.set(s.id, { en: s.text, hash: s.hash, math: !!b.inlineMath });
  return out;
}

/** `{"id": "zh"}`, or the batch protocol's `{"translations":[{id, zh}]}`. */
function entries(obj: unknown): [string, string][] {
  if (!obj || typeof obj !== "object") return [];
  const list = (obj as any).translations;
  if (Array.isArray(list)) return list.filter((t) => typeof t?.id === "string" && typeof t?.zh === "string").map((t) => [t.id, t.zh]);
  return Object.entries(obj as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string");
}

export interface Collected {
  ok: Record<string, string>;
  /** Expected ids that came back unusable, with the reason. */
  bad: Record<string, string>;
}

/** Merge result files in order (later ones win) and check every expected sentence. */
export function collect(files: unknown[], expected: Map<string, Expected>): Collected {
  const latest = new Map<string, string>();
  for (const f of files) for (const [id, zh] of entries(f)) if (expected.has(id)) latest.set(id, zh.trim());
  const ok: Record<string, string> = {};
  const bad: Record<string, string> = {};
  for (const [id, zh] of latest) {
    const e = expected.get(id)!;
    const problem = checkUnit(e.en, zh, e.math);
    if (problem) bad[id] = problem;
    else ok[id] = zh;
  }
  return { ok, bad };
}

export interface TaskOptions {
  /** Absolute path of the task directory, so the task works from any agent session. */
  dir: string;
  title?: string;
  /** User glossary, one `English = 中文` per line. */
  glossary?: string;
  todo: number;
  /** Some sentences already have translations. */
  partial: boolean;
  math: boolean;
}

/** What the reader pastes into an agent session: the task itself is in the directory. */
export function startPrompt(dir: string): string {
  return `请完成一个论文翻译任务。任务目录是 ${dir}，请先阅读其中的 TASK.md，然后按要求只在这个目录里读写文件。`;
}

export function fixPrompt(dir: string): string {
  return `请完成一个补译任务。任务目录是 ${dir}，请阅读其中的 FIX.md，然后按要求只在这个目录里读写文件。`;
}

/** Ready-to-run PowerShell lines that start each agent CLI inside the task directory. */
export function startCommands(dir: string): { tool: string; line: string }[] {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const ask = q("请阅读 TASK.md，并按其中的要求完成任务。");
  return [
    { tool: "Grok Build", line: `Set-Location -LiteralPath ${q(dir)}; grok ${ask}` },
    { tool: "Codex CLI", line: `codex -C ${q(dir)} ${ask}` },
    { tool: "Claude Code", line: `Set-Location -LiteralPath ${q(dir)}; claude ${ask}` },
  ];
}

export type HandoffPhase = "waiting" | "glossary" | "translating" | "checking" | "done";

/** Where the agent is, judged only from the files it has written. */
export function handoffPhase(o: { glossary: boolean; delivered: number; todo: number; report: boolean }): HandoffPhase {
  if (o.report) return "done";
  if (o.delivered >= o.todo && o.todo > 0) return "checking";
  if (o.delivered > 0) return "translating";
  return o.glossary ? "glossary" : "waiting";
}

export function taskText(o: TaskOptions): string {
  const title = o.title ? `《${o.title}》` : "";
  const glossary = o.glossary?.trim();
  return [
    "# 任务：把一篇英文论文译成中文（供中英对照阅读）",
    "",
    `任务目录：\`${o.dir}\`。下文提到的文件都在这个目录里。`,
    "",
    `\`units.json\` 是论文${title}的全部句子，按“章节 → 段落 → 句子”组织，每个句子有唯一编号 \`id\`。` +
      (o.partial ? `带 \`zh\` 的句子已有译文，不用再译，但请沿用其中的术语和说法；其余 ${o.todo} 句需要你翻译。` : `共 ${o.todo} 句，全部需要翻译。`),
    "",
    "## 交付物（都写在任务目录，不要改动 units.json）",
    "",
    "0. 确定术语后，先写出 `glossary.md`（每行 English = 中文），再开始翻译。",
    `1. 每译完一部分（例如一个章节），立即把这部分写成 \`${PARTS_DIR}/\` 目录下的一个 JSON 文件，文件名自定，内容为 \`{"<id>": "<中文译文>", ...}\`。外部程序会读取这些文件，边译边显示给读者。`,
    `2. 全部完成后写 \`${RESULT_FILE}\`，格式相同，包含你翻译的全部 id，每个 id 恰好一条。`,
    "3. `report.md`：最后写的简短报告，说明做法（是否分工、怎样保证全文一致）、自查结果、仍有疑问的句子。外部程序看到它就认为任务已经结束，所以请在所有译文都写好之后再写。",
    "",
    "## 译文要求",
    "",
    "- 文风：按这篇论文所属领域的中文学术期刊的写法来写，用该领域中文作者的习惯说法，读者不应察觉这是译文。",
    "- 忠实：不增不减信息；may、slightly、to some extent 等限定语和否定都要保留；不添加原文没有的解释。",
    `- 原样保留：引用编号（如 [12]、[3]–[5]）、数字与单位、变量名与符号、模型名和数据集名${o.math ? "、`$...$` 形式的公式（连同美元符号）" : ""}。`,
    "- 全文术语统一，以 glossary.md 为准；缩写首次出现时可写作“中文（英文全称，缩写）”，之后统一。",
    "- 一个英文句子可以译成几个中文句子，但都放在该 id 的译文里；不要把相邻两个 id 合并，也不要把一个 id 拆开。",
    "- 标题简洁，保留 “II.” “B.” “3.1” 这类编号。作者姓名、机构等专名照抄原文。",
    "- 原文若有排版或 OCR 残留（符号粘连、断词），按可判断的原意翻译，不要擅自补造公式或数据，并在报告中列出。",
    ...(glossary ? ["", "## 必须采用的术语（读者指定，优先于你自己的术语表）", "", "```", glossary, "```"] : []),
    "",
    "## 建议做法（可自行调整）",
    "",
    "先通读全文、确定术语表，再按章节翻译；可以使用子代理并行，但各部分须共用同一份术语表。全部完成后自查：所有待译 id 都有译文，引用编号和公式完整，术语前后一致，相邻句子衔接自然，然后写报告。",
    "",
    "只在任务目录内读写文件，不需要联网。",
    "",
  ].join("\n");
}

export interface FixItem {
  id: string;
  en: string;
  previous?: string;
  problem: string;
}

export function fixText(count: number, dir: string): string {
  return [
    "# 补译任务",
    "",
    `任务目录：\`${dir}\`。下文提到的文件都在这个目录里。`,
    "",
    `上一轮翻译后，有 ${count} 个句子没有通过程序检查，列在 \`${FIX_FILE}\` 里（每条有 id、英文原文、上一轮译文和问题；问题为空的表示上一轮没有交付这句）。`,
    "",
    `请结合 \`units.json\` 中的上下文和 \`glossary.md\`（若存在）重新翻译这些句子，写入 \`${FIX_RESULT_FILE}\`，格式为 \`{"<id>": "<中文译文>", ...}\`，每个 id 恰好一条。译文要求与 TASK.md 相同；问题中的 lost citation 表示漏掉了引用编号，not translated 表示没有译成中文，lost inline math 表示漏掉了行内公式。`,
    "",
    "只在任务目录内读写文件，不需要联网。",
    "",
  ].join("\n");
}
