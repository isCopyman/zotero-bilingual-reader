// Engine adapters inside Zotero: agent CLIs through Firefox's Subprocess module, OpenAI-compatible
// APIs through Zotero.HTTP. Same Engine contract as the Node CLI (tools/engines-node.ts).

import type { EngineInfo } from "../../core/host-api";
import type { Engine, EnginePrompt } from "../../core/translate/runner";
import { engineIdOf, loadProviders, resolveApiEngine, type ApiProvider } from "./api-providers";
import { getPref } from "./prefs";
import { clearTimeout, newTextDecoder, setTimeout } from "./globals";

const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs") as any;
const isWin = Zotero.isWin;

function homeDir(): string {
  return (Services as any).dirsvc.get("Home", (Components.interfaces as any).nsIFile).path;
}

async function exists(path: string): Promise<boolean> {
  try {
    return !!path && (await IOUtils.exists(path));
  } catch {
    return false;
  }
}

/**
 * Drain a pipe as raw bytes and decode once at the end. readString() can legitimately return ""
 * while a multi-byte UTF-8 character is split across chunks, so only a zero-byte read means EOF.
 */
async function readAll(pipe: any): Promise<string> {
  const decoder = newTextDecoder();
  let out = "";
  for (;;) {
    const buf: ArrayBuffer = await pipe.read();
    if (!buf || !buf.byteLength) break;
    out += decoder.decode(new Uint8Array(buf), { stream: true });
  }
  return out + decoder.decode();
}

function killQuietly(proc: any) {
  try {
    Promise.resolve(proc.kill()).catch(() => {});
  } catch {
    /* already gone */
  }
}

/** Run a program, feed stdin, collect stdout. Rejects on non-zero exit, timeout or abort. */
export async function runProcess(command: string, args: string[], stdin: string | null, signal?: AbortSignal, timeoutMs = 300_000, workdir?: string, env?: Record<string, string>): Promise<string> {
  if (signal?.aborted) throw new Error("已取消");
  const proc = await Subprocess.call({ command, arguments: args, stderr: "pipe", ...(workdir ? { workdir } : {}), ...(env ? { environment: env, environmentAppend: true } : {}) });
  let killedFor = "";
  const kill = (why: string) => {
    killedFor ||= why;
    killQuietly(proc);
  };
  // An abort that landed while the process was starting fires no event; check it explicitly.
  if (signal?.aborted) kill("aborted");
  const timer = setTimeout(() => kill("timeout"), timeoutMs);
  const onAbort = () => kill("aborted");
  signal?.addEventListener("abort", onAbort, { once: true });
  let exited = false;
  // Start draining both pipes before writing stdin so a chatty child cannot block on a full pipe.
  const output = Promise.all([readAll(proc.stdout), readAll(proc.stderr)]);
  // If writing stdin fails first, this rejection is handled below; do not report it as unhandled.
  output.catch(() => {});
  try {
    try {
      if (stdin !== null && !killedFor) await proc.stdin.write(stdin);
      await proc.stdin.close();
    } catch (e) {
      if (!killedFor) throw e;
    }
    const [out, err] = await output;
    const { exitCode } = await proc.wait();
    exited = true;
    if (killedFor) throw new Error(killedFor === "timeout" ? `超时（${Math.round(timeoutMs / 1000)} 秒）` : "已取消");
    if (exitCode !== 0) throw new Error(`退出码 ${exitCode}：${(err || out).trim().slice(-400)}`);
    return out;
  } catch (e) {
    // Any failure (stdin write, pipe read) must not leave the child running while the caller
    // retries with a new one. Keep the original error.
    if (!exited) {
      kill("error");
      await proc.wait().catch(() => {});
    }
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

const detected = new Map<string, Promise<string | null>>();

/**
 * Native codex.exe inside an npm installation (`npm i -g @openai/codex`). The npm shims
 * (codex.cmd / codex.ps1) need a shell, which Subprocess does not run, so use the binary they call.
 */
async function npmCodexExe(npmDir: string): Promise<string | null> {
  const pkg = PathUtils.join(npmDir, "node_modules", "@openai", "codex", "node_modules", "@openai");
  for (const [arch, triple] of [["x64", "x86_64-pc-windows-msvc"], ["arm64", "aarch64-pc-windows-msvc"]]) {
    const exe = PathUtils.join(pkg, `codex-win32-${arch}`, "vendor", triple, "bin", "codex.exe");
    if (await exists(exe)) return exe;
  }
  return null;
}

/** A configured path to the npm shim maps to its native binary. */
export async function resolveCodexPath(path: string): Promise<string | null> {
  if (/\.(cmd|ps1|bat)$/i.test(path) || /[\\/]codex$/i.test(path)) {
    const native = await npmCodexExe(PathUtils.parent(path)!);
    if (native) return native;
  }
  return (await exists(path)) ? path : null;
}

async function detectCodex(): Promise<string | null> {
  if (!isWin) {
    try {
      return await Subprocess.pathSearch("codex");
    } catch {
      return null;
    }
  }
  // Prefer the Codex CLI installed with npm (usually the newest), then the desktop app's copy.
  const appData = (Services as any).env.get("APPDATA");
  const npm = appData && (await npmCodexExe(PathUtils.join(appData, "npm")));
  if (npm) return npm;
  // WindowsApps cannot be listed, so ask the package manager where the desktop app lives.
  const ps = PathUtils.join((Services as any).env.get("SystemRoot") || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    const loc = (await runProcess(ps, ["-NoProfile", "-NonInteractive", "-Command", "(Get-AppxPackage OpenAI.Codex).InstallLocation"], null, undefined, 20_000)).trim().split(/\r?\n/)[0];
    const exe = loc && PathUtils.join(loc, "app", "resources", "codex.exe");
    return exe && (await exists(exe)) ? exe : null;
  } catch {
    return null;
  }
}

async function locate(name: "grok" | "codex" | "claude"): Promise<string | null> {
  const configured = String(getPref(`${name}Path`) || "").trim();
  if (configured) return name === "codex" ? resolveCodexPath(configured) : (await exists(configured)) ? configured : null;
  if (!detected.has(name)) {
    detected.set(
      name,
      (async () => {
        const exe = isWin ? ".exe" : "";
        if (name === "grok") {
          const p = PathUtils.join(homeDir(), ".grok", "bin", `grok${exe}`);
          return (await exists(p)) ? p : null;
        }
        if (name === "claude") {
          const p = PathUtils.join(homeDir(), ".local", "bin", `claude${exe}`);
          return (await exists(p)) ? p : null;
        }
        return detectCodex();
      })(),
    );
  }
  return detected.get(name)!;
}

export function resetDetection() {
  detected.clear();
}

const timeout = () => Number(getPref("agentTimeoutSec") || 300) * 1000;
const model = (name: string) => String(getPref(`${name}Model`) || "").trim();
/** Reasoning effort; empty leaves it to the tool's own configuration. */
const effort = (name: string) => String(getPref(`${name}Effort`) || "").trim();

/** Working directory of single-shot agent calls, so their session records stay in one place. */
const agentHomePath = () => PathUtils.join(Zotero.DataDirectory.dir, "zotero-bilingual-reader", "agent");

async function agentHome(): Promise<string> {
  const dir = agentHomePath();
  await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
  return dir;
}

/**
 * grok keeps every headless call as a session under ~/.grok/sessions/<encoded working directory>/
 * and has no switch to turn that off. The plugin's calls all run in its own directory, so that
 * folder holds nothing but translation requests; it is removed when translation goes idle.
 * Codex (--ephemeral) and Claude Code (--no-session-persistence) keep nothing.
 */
export async function cleanupAgentSessions() {
  const dir = PathUtils.join(homeDir(), ".grok", "sessions", encodeURIComponent(agentHomePath()));
  try {
    await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
  } catch (e) {
    Zotero.debug(`[zbr] could not remove grok sessions: ${e}`);
  }
}

// Each engine instance freezes its model and effort settings: the scheduler's engine cache is keyed
// by them, so a changed setting makes a new instance while running jobs finish with the old one.
function grokEngine(exe: string): Engine {
  const m = model("grok");
  const e = effort("grok");
  const choice = [...(m ? ["-m", m] : []), ...(e ? ["--effort", e] : [])];
  return {
    id: "agent:grok",
    label: "Grok Build",
    async complete(p: EnginePrompt, signal) {
      const flags = ["--max-turns", "1", "--output-format", "plain", "--disable-web-search", ...choice];
      const cwd = await agentHome();
      // Cross-session memory stays off for these calls whatever grok's own configuration says.
      const env = { GROK_MEMORY: "0" };
      // Windows limits a command line to 32767 characters; long prompts go through a file.
      if (p.combined.length < 12_000) return runProcess(exe, ["-p", p.combined, "--cwd", cwd, ...flags], null, signal, timeout(), cwd, env);
      const file = PathUtils.join(PathUtils.tempDir, `zbr-grok-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
      await IOUtils.writeUTF8(file, p.combined);
      try {
        return await runProcess(exe, ["--prompt-file", file, "--cwd", cwd, ...flags], null, signal, timeout(), cwd, env);
      } finally {
        await IOUtils.remove(file, { ignoreAbsent: true }).catch(() => {});
      }
    },
  };
}

function codexEngine(exe: string): Engine {
  const m = model("codex");
  const e = effort("codex");
  const choice = [...(m ? ["-m", m] : []), ...(e ? ["-c", `model_reasoning_effort=${e}`] : [])];
  return {
    id: "agent:codex",
    label: "Codex CLI",
    async complete(p: EnginePrompt, signal) {
      const cwd = await agentHome();
      const outFile = PathUtils.join(PathUtils.tempDir, `zbr-codex-${Zotero.Utilities.randomString(8)}.txt`);
      try {
        await runProcess(exe, ["exec", "--skip-git-repo-check", "--ephemeral", "-C", cwd, "-s", "read-only", ...choice, "-o", outFile, "-"], p.combined, signal, timeout(), cwd);
        return await IOUtils.readUTF8(outFile);
      } finally {
        await IOUtils.remove(outFile, { ignoreAbsent: true }).catch(() => {});
      }
    },
  };
}

function claudeEngine(exe: string): Engine {
  const m = model("claude");
  const e = effort("claude");
  const choice = [...(m ? ["--model", m] : []), ...(e ? ["--effort", e] : [])];
  return {
    id: "agent:claude",
    label: "Claude Code",
    complete: async (p: EnginePrompt, signal) =>
      runProcess(exe, ["-p", "--output-format", "text", "--max-turns", "1", "--tools", "", "--no-session-persistence", ...choice], p.combined, signal, timeout(), await agentHome()),
  };
}

function apiEngine(p: ApiProvider, m: string): Engine {
  const { base, key, effort } = p;
  return {
    id: engineIdOf(p, m),
    label: `${p.name} · ${m}`,
    async complete(p: EnginePrompt, signal) {
      if (signal?.aborted) throw new Error("已取消");
      let cancel: (() => void) | undefined;
      const onAbort = () => cancel?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      let xhr: any;
      try {
        xhr = await Zotero.HTTP.request("POST", `${base}/chat/completions`, {
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: m,
            temperature: 0.2,
            ...(effort ? { reasoning_effort: effort } : {}),
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: p.system },
              { role: "user", content: p.user },
            ],
          }),
          responseType: "json",
          timeout: timeout(),
          successCodes: false,
          // Aborting the XHR itself, so a stopped batch stops costing tokens and connections.
          cancellerReceiver: (fn: () => void) => {
            cancel = fn;
            if (signal?.aborted) fn();
          },
        } as any);
      } catch (e: any) {
        if (signal?.aborted) throw new Error("已取消");
        throw e;
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
      if (xhr.status < 200 || xhr.status >= 300) throw new Error(`HTTP ${xhr.status}：${JSON.stringify(xhr.response ?? "").slice(0, 300)}`);
      return xhr.response?.choices?.[0]?.message?.content ?? "";
    },
  };
}

export interface ModelChoice {
  id: string;
  label: string;
  /** Reasoning-effort levels the model accepts, and its default. */
  efforts: string[];
  defaultEffort?: string;
}

async function readJSON(path: string): Promise<any> {
  try {
    return (await IOUtils.exists(path)) ? await IOUtils.readJSON(path) : null;
  } catch {
    return null;
  }
}

/**
 * Models each agent CLI offers on this machine, read from the model lists the tools themselves
 * keep (grok: ~/.grok/models_cache.json, Codex: ~/.codex/models_cache.json). Claude Code accepts
 * the aliases below or a full model id.
 */
export async function modelChoices(): Promise<Record<"grok" | "codex" | "claude", ModelChoice[]>> {
  const home = homeDir();
  const grok: ModelChoice[] = [];
  const g = await readJSON(PathUtils.join(home, ".grok", "models_cache.json"));
  for (const entry of Object.values<any>(g?.models ?? {})) {
    const info = entry?.info;
    if (!info?.id || info.hidden) continue;
    const efforts: any[] = Array.isArray(info.reasoning_efforts) ? info.reasoning_efforts : [];
    grok.push({
      id: info.id,
      label: [info.name || info.id, info.description].filter(Boolean).join(" · "),
      efforts: efforts.map((x) => String(x.value ?? x.id)),
      defaultEffort: efforts.find((x) => x.default)?.value ?? info.reasoning_effort,
    });
  }
  const codex: ModelChoice[] = [];
  const c = await readJSON(PathUtils.join(home, ".codex", "models_cache.json"));
  for (const m of c?.models ?? []) {
    if (!m?.slug || m.visibility !== "list") continue;
    codex.push({
      id: m.slug,
      label: [m.display_name || m.slug, m.description].filter(Boolean).join(" · "),
      efforts: (m.supported_reasoning_levels ?? []).map((x: any) => String(x.effort)),
      defaultEffort: m.default_reasoning_level,
    });
  }
  const levels = ["low", "medium", "high", "xhigh", "max"];
  const claude: ModelChoice[] = [
    { id: "haiku", label: "Haiku · 最快、最省", efforts: levels },
    { id: "sonnet", label: "Sonnet · 均衡", efforts: levels },
    { id: "opus", label: "Opus · 最强", efforts: levels },
  ];
  return { grok, codex, claude };
}

async function readText(path: string): Promise<string> {
  try {
    return (await IOUtils.exists(path)) ? await IOUtils.readUTF8(path) : "";
  } catch {
    return "";
  }
}

/** `key = "value"` inside a TOML section ("" = top level, before any [section]). */
function tomlValue(text: string, section: string, key: string): string | undefined {
  let current = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const head = line.match(/^\[([^\]]+)\]$/);
    if (head) {
      current = head[1].trim();
      continue;
    }
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*"([^"]*)"/);
    if (m && current === section && m[1] === key) return m[2];
  }
  return undefined;
}

/** What each tool uses when we pass no model or effort: read from its own configuration. */
export async function toolDefaults(): Promise<Record<"grok" | "codex" | "claude", { model?: string; effort?: string }>> {
  const home = homeDir();
  const grok = await readText(PathUtils.join(home, ".grok", "config.toml"));
  const codex = await readText(PathUtils.join(home, ".codex", "config.toml"));
  const claude = (await readJSON(PathUtils.join(home, ".claude", "settings.json"))) ?? {};
  const grokModels = await readJSON(PathUtils.join(home, ".grok", "models_cache.json"));
  const grokModel = tomlValue(grok, "models", "default");
  return {
    grok: {
      model: grokModel,
      effort: tomlValue(grok, "models", "default_reasoning_effort") ?? grokModels?.models?.[grokModel ?? ""]?.info?.reasoning_effort,
    },
    codex: { model: tomlValue(codex, "", "model"), effort: tomlValue(codex, "", "model_reasoning_effort") },
    claude: { model: typeof claude.model === "string" ? claude.model : undefined, effort: typeof claude.effortLevel === "string" ? claude.effortLevel : undefined },
  };
}

export async function listEngines(): Promise<EngineInfo[]> {
  const [grok, codex, claude] = await Promise.all([locate("grok"), locate("codex"), locate("claude")]);
  const apis: EngineInfo[] = loadProviders().flatMap((p) =>
    p.models.map((m) => ({
      id: engineIdOf(p, m),
      label: `${p.name} · ${m}`,
      kind: "api" as const,
      ready: !!p.base && !!p.key,
      note: p.key ? p.base : "未填写 API Key",
    })),
  );
  return [
    { id: "agent:grok", label: "Grok Build", kind: "agent", ready: !!grok, note: grok ?? "未找到 grok" },
    { id: "agent:codex", label: "Codex CLI", kind: "agent", ready: !!codex, note: codex ?? "未找到 Codex CLI（npm 安装）或 Codex 桌面应用" },
    { id: "agent:claude", label: "Claude Code", kind: "agent", ready: !!claude, note: claude ?? "未找到 claude" },
    ...apis,
    ...[...extraEngines.values()].map((e) => e.info),
  ];
}

/**
 * Everything that changes what an engine would produce or where it runs. The host rebuilds its
 * engine when this changes, and stores it with each translation.
 */
/** Extra engines registered at runtime (integration tests, other plugins). */
const extraEngines = new Map<string, { info: EngineInfo; create: () => Engine; concurrency: number }>();

export function registerEngine(info: EngineInfo, create: () => Engine, concurrency = 2) {
  extraEngines.set(info.id, { info, create, concurrency });
}

export function unregisterEngine(id: string) {
  extraEngines.delete(id);
}

export function engineConfigKey(id: string): string {
  if (extraEngines.has(id)) return id;
  const name = id.split(":")[1];
  if (id.startsWith("api:")) {
    const r = resolveApiEngine(id);
    if (!r) return id;
    const { provider: p, model } = r;
    return [engineIdOf(p, model), p.base, model, p.effort || "default", Zotero.Utilities.Internal.md5(p.key, false).slice(0, 8)].join("|");
  }
  return [id, getPref(`${name}Path`) || "auto", getPref(`${name}Model`) || "default", getPref(`${name}Effort`) || "default"].join("|");
}

/** Current parallel-request limit for an engine; read on every scheduling round so changes apply at once. */
export function engineConcurrency(id: string): number {
  const extra = extraEngines.get(id);
  if (extra) return extra.concurrency;
  if (id.startsWith("api:")) return resolveApiEngine(id)?.provider.concurrency ?? 4;
  return Math.max(1, Number(getPref("agentConcurrency") || 4));
}

export async function getEngine(id: string): Promise<{ engine: Engine; concurrency: number }> {
  const extra = extraEngines.get(id);
  if (extra) return { engine: extra.create(), concurrency: extra.concurrency };
  const agentConc = engineConcurrency(id);
  switch (id) {
    case "agent:grok": {
      const exe = await locate("grok");
      if (!exe) throw new Error("未找到 grok，可在设置中填写路径");
      return { engine: grokEngine(exe), concurrency: agentConc };
    }
    case "agent:codex": {
      const exe = await locate("codex");
      if (!exe) throw new Error("未找到 Codex CLI（npm i -g @openai/codex）或 Codex 桌面应用，可在设置中填写路径");
      return { engine: codexEngine(exe), concurrency: agentConc };
    }
    case "agent:claude": {
      const exe = await locate("claude");
      if (!exe) throw new Error("未找到 claude，可在设置中填写路径");
      return { engine: claudeEngine(exe), concurrency: agentConc };
    }
    default: {
      const api = id.startsWith("api:") ? resolveApiEngine(id) : null;
      if (!api) throw new Error(id.startsWith("api:") ? "这个 API 模型已不在设置里，请重新选择翻译引擎" : `未知引擎 ${id}`);
      if (!api.provider.key) throw new Error(`请先在设置中填写「${api.provider.name}」的 API Key`);
      return { engine: apiEngine(api.provider, api.model), concurrency: api.provider.concurrency };
    }
  }
}
