// Per-paper glossary for batch translation: one short request reads the title, headings, abstract
// and the start of the introduction and fixes the renderings of the paper's key terms, so that
// separately translated paragraphs use the same words.

import type { ZbrDocument } from "../model";
import type { EnginePrompt } from "./runner";

/** Title, headings and the opening paragraphs, up to about `limit` characters. */
export function glossarySource(doc: ZbrDocument, limit = 5000): string {
  const headings = doc.blocks.filter((b) => b.kind === "heading").map((b) => `# ${b.text}`);
  const paragraphs: string[] = [];
  let used = headings.join("\n").length;
  for (const b of doc.blocks) {
    if (b.kind !== "paragraph" || !b.translatable || b.role) continue;
    if (used + b.text.length > limit) break;
    paragraphs.push(b.text);
    used += b.text.length;
  }
  return [doc.title ? `Title: ${doc.title}` : "", "Headings:", ...headings, "", "Opening paragraphs:", ...paragraphs].filter((l) => l !== undefined).join("\n");
}

export function glossaryPrompt(doc: ZbrDocument, targetLang = "简体中文"): EnginePrompt {
  const system = [
    `You prepare a terminology list for translating one scientific paper into ${targetLang}.`,
    `List the paper's key technical terms (methods, model components, quantities, task names, recurring phrases) with the rendering a native ${targetLang} author of this field would use, as in that field's ${targetLang} journals.`,
    "Keep acronyms, model names and dataset names as they are; include an acronym only when it needs a fixed expansion.",
    "At most 40 terms, most important first.",
    'Output only JSON: {"terms":[{"en":"...","zh":"..."}]} with no commentary or code fences.',
  ].join("\n");
  const user = glossarySource(doc);
  return { system, user, combined: `${system}\n\nDo not use any tools; answer directly.\n\n${user}` };
}

/** `English = 中文` lines from the model's answer; empty when it is not usable. */
export function parseGlossary(text: string): string {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  let data: any = null;
  try {
    data = JSON.parse(t);
  } catch {
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        data = JSON.parse(t.slice(a, b + 1));
      } catch {
        /* unusable */
      }
    }
  }
  const terms: any[] = Array.isArray(data?.terms) ? data.terms : [];
  return terms
    .filter((x) => typeof x?.en === "string" && typeof x?.zh === "string" && x.en.trim() && x.zh.trim())
    .slice(0, 60)
    .map((x) => `${x.en.trim()} = ${x.zh.trim()}`)
    .join("\n");
}

/** The reader's own glossary wins over the paper glossary for the same English term. */
export function mergeGlossaries(user: string, paper: string): string {
  const key = (line: string) => line.split("=")[0].trim().toLowerCase();
  const own = user.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.includes("="));
  const taken = new Set(own.map(key));
  const rest = paper.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.includes("=") && !taken.has(key(l)));
  return [...own, ...rest].join("\n");
}
