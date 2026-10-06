// Runtime-agnostic batch runner: prompts an engine, validates ids, re-asks for whatever is missing.

import { combinedPrompt, parseResponse, subBatch, systemPrompt, userPrompt, type Batch, type PromptOptions } from "./protocol";

export interface EnginePrompt {
  system: string;
  user: string;
  /** System + user in one message, for CLI agents that take a single prompt. */
  combined: string;
}

export interface Engine {
  id: string;
  label: string;
  /** Sentence units per request the engine handles comfortably. */
  maxUnits?: number;
  complete(prompt: EnginePrompt, signal?: AbortSignal): Promise<string>;
}

export interface BatchOutcome {
  ok: Record<string, string>;
  failed: string[];
  problems: string[];
}

export function buildPrompt(batch: Batch, opts: PromptOptions): EnginePrompt {
  return { system: systemPrompt(opts), user: userPrompt(batch, opts), combined: combinedPrompt(batch, opts) };
}

/** Translate one batch; ids the model dropped or broke are re-asked up to `retries` times. */
export async function runBatch(engine: Engine, batch: Batch, opts: PromptOptions, retries = 2, signal?: AbortSignal): Promise<BatchOutcome> {
  const ok: Record<string, string> = {};
  const problems: string[] = [];
  let todo = batch;
  for (let attempt = 0; attempt <= retries && todo.ids.length; attempt++) {
    signal?.throwIfAborted();
    let text: string;
    try {
      text = await engine.complete(buildPrompt(todo, opts), signal);
    } catch (e: any) {
      if (signal?.aborted) throw e;
      problems.push(`attempt ${attempt + 1}: ${e?.message ?? e}`);
      continue;
    }
    const r = parseResponse(text, todo);
    Object.assign(ok, r.ok);
    if (r.problems.length) problems.push(...r.problems.map((p) => `attempt ${attempt + 1}: ${p}`));
    todo = subBatch(todo, new Set(r.missing));
  }
  return { ok, failed: todo.ids, problems };
}

/** Run tasks with bounded concurrency, preserving nothing about order. */
export async function pool<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}
