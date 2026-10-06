// Engine adapters for Node (batch CLI). The Zotero host has its own Subprocess-based twins.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { Engine, EnginePrompt } from "../core/translate/runner";

interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
}

function run(exe: string, args: string[], stdin: string | null, signal?: AbortSignal, timeoutMs = 300_000, opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : undefined,
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (out += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(exe)} exited ${code}: ${(err || out).trim().slice(-400)}`));
    });
    if (stdin !== null) child.stdin.end(stdin, "utf8");
    else child.stdin.end();
  });
}

/**
 * The npm codex can lag behind the configured model; prefer the desktop app's bundled binary.
 * WindowsApps cannot be listed by normal users, so ask the package manager where it lives.
 */
export function findCodex(): string | null {
  if (process.env.ZBR_CODEX && existsSync(process.env.ZBR_CODEX)) return process.env.ZBR_CODEX;
  if (process.platform !== "win32") return null;
  try {
    const loc = execFileSync("powershell.exe", ["-NoProfile", "-Command", "(Get-AppxPackage OpenAI.Codex).InstallLocation"], { encoding: "utf8", windowsHide: true }).trim();
    const exe = loc && path.join(loc.split(/\r?\n/)[0], "app", "resources", "codex.exe");
    return exe && existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

export function findGrok(): string | null {
  const exe = path.join(homedir(), ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok");
  return existsSync(exe) ? exe : null;
}

export function findClaude(): string | null {
  const exe = path.join(homedir(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");
  return existsSync(exe) ? exe : null;
}

/** `cwd`: where grok keeps the sessions of these calls (one folder per working directory). */
export function grokEngine(exe = findGrok()!, model?: string, opts: { cwd?: string; effort?: string } = {}): Engine {
  const extra = [...(model ? ["-m", model] : []), ...(opts.effort ? ["--effort", opts.effort] : [])];
  return {
    id: "agent:grok",
    label: "Grok Build",
    complete: (p: EnginePrompt, signal) =>
      run(exe, ["-p", p.combined, "--max-turns", "1", "--output-format", "plain", "--disable-web-search", ...extra], null, signal, 300_000, {
        cwd: opts.cwd,
        env: { GROK_MEMORY: "0" },
      }),
  };
}

export function codexEngine(exe = findCodex()!, model?: string, effort?: string): Engine {
  return {
    id: "agent:codex",
    label: "Codex CLI",
    async complete(p: EnginePrompt, signal) {
      const dir = mkdtempSync(path.join(tmpdir(), "zbr-codex-"));
      const outFile = path.join(dir, "last.txt");
      try {
        await run(exe, ["exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", ...(model ? ["-m", model] : []), ...(effort ? ["-c", `model_reasoning_effort=${effort}`] : []), "-o", outFile, "-"], p.combined, signal);
        return readFileSync(outFile, "utf8");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

export function claudeEngine(exe = findClaude()!, model?: string, effort?: string): Engine {
  return {
    id: "agent:claude",
    label: "Claude Code",
    complete: (p: EnginePrompt, signal) =>
      run(exe, ["-p", "--output-format", "text", "--max-turns", "1", "--tools", "", "--no-session-persistence", ...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : [])], p.combined, signal),
  };
}

/** `effort`: sent as reasoning_effort when set (servers that do not know it ignore or reject it). */
export function openaiEngine(base: string, key: string, model: string, effort?: string): Engine {
  return {
    id: "api:openai",
    label: `API ${model}`,
    async complete(p: EnginePrompt, signal) {
      const res = await fetch(`${base.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          ...(effort ? { reasoning_effort: effort } : {}),
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: p.system },
            { role: "user", content: p.user },
          ],
        }),
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const j: any = await res.json();
      return j.choices?.[0]?.message?.content ?? "";
    },
  };
}
