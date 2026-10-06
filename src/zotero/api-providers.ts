// OpenAI-compatible API providers. Each provider has its own endpoint, key, request limit and
// reasoning effort; every model the reader ticks becomes a separate engine "api:<provider>:<model>".
// Stored as JSON in the apiProviders pref; the single-API prefs of earlier versions become the
// first provider.

import { getPref, setPref } from "./prefs";

export interface ApiProvider {
  id: string;
  name: string;
  base: string;
  key: string;
  /** Models offered as engines in the reader. */
  models: string[];
  /** Parallel requests per model. */
  concurrency: number;
  /** reasoning_effort sent with each request; "" sends none. */
  effort: string;
}

export const API_EFFORTS = ["", "none", "low", "medium", "high"];

/** The CLIProxyAPI that runs on this machine (OpenAI-compatible, models from its own list). */
export const LOCAL_CPA = { name: "本机 CLIProxyAPI", base: "http://127.0.0.1:8317/v1", models: ["k3-256k"], concurrency: 16, effort: "low" };

export function loadProviders(): ApiProvider[] {
  const raw = String(getPref("apiProviders") || "");
  if (raw) {
    try {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) return list.map(normalize);
    } catch (e) {
      Zotero.logError(e as Error);
    }
  }
  // Earlier versions: one API with base, key and model.
  const key = String(getPref("apiKey") || "");
  const model = String(getPref("apiModel") || "");
  if (!key) return [];
  return [
    normalize({
      id: "p1",
      name: "OpenAI 兼容 API",
      base: String(getPref("apiBase") || "https://api.openai.com/v1"),
      key,
      models: model ? [model] : [],
      concurrency: Number(getPref("apiConcurrency") || 4),
      effort: "",
    }),
  ];
}

function normalize(p: any): ApiProvider {
  return {
    id: String(p.id || newId([])),
    name: String(p.name || "API"),
    base: String(p.base || "").trim().replace(/\/+$/, ""),
    key: String(p.key || ""),
    models: Array.isArray(p.models) ? [...new Set(p.models.map(String).filter(Boolean))] as string[] : [],
    concurrency: Math.min(64, Math.max(1, Number(p.concurrency) || 8)),
    effort: API_EFFORTS.includes(p.effort) ? p.effort : "",
  };
}

export function saveProviders(list: ApiProvider[]) {
  setPref("apiProviders", JSON.stringify(list.map(normalize)));
}

export function newId(list: ApiProvider[]): string {
  let n = list.length + 1;
  while (list.some((p) => p.id === `p${n}`)) n++;
  return `p${n}`;
}

export function engineIdOf(p: ApiProvider, model: string): string {
  return `api:${p.id}:${model}`;
}

/**
 * "api:<provider>:<model>" (model names may contain colons). The old single engine id
 * "api:openai" means the first model of the first provider.
 */
export function resolveApiEngine(id: string): { provider: ApiProvider; model: string } | null {
  const list = loadProviders();
  if (id === "api:openai") {
    const p = list.find((x) => x.models.length);
    return p ? { provider: p, model: p.models[0] } : null;
  }
  const m = /^api:([^:]+):(.+)$/.exec(id);
  if (!m) return null;
  const provider = list.find((x) => x.id === m[1]);
  return provider ? { provider, model: m[2] } : null;
}

/** Model ids the endpoint lists (GET {base}/models). */
export async function fetchModels(base: string, key: string): Promise<string[]> {
  const xhr: any = await Zotero.HTTP.request("GET", `${base.replace(/\/+$/, "")}/models`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    responseType: "json",
    timeout: 20_000,
    successCodes: false,
  } as any);
  if (xhr.status < 200 || xhr.status >= 300) throw new Error(`HTTP ${xhr.status}：${JSON.stringify(xhr.response ?? "").slice(0, 200)}`);
  const data = xhr.response?.data ?? xhr.response?.models ?? [];
  return [...new Set((Array.isArray(data) ? data : []).map((m: any) => String(m?.id ?? m?.name ?? m)).filter(Boolean))].sort() as string[];
}
