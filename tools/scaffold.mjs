// Runs zotero-plugin-scaffold with an SWC native cache it accepts. SWC refuses cache roots whose
// ACL grants write access to other principals (e.g. an AppContainer SID left by a sandboxed tool
// on %LOCALAPPDATA%\swc), so default to a private folder under the user profile.
//
// For `test`, Zotero instances left over from earlier runs keep the test profile locked, so
// before and after the run we end the zotero.exe processes started with THIS repo's test
// profile. The user's own Zotero never runs with that profile and is not touched.
// The test Zotero also does not reliably quit once the tests are done (the scaffold then waits
// minutes, or forever when its output is piped), so the wrapper ends it as soon as the result
// line appears.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const env = { ...process.env };
if (!env.SWC_NATIVE_BINDING_CACHE) {
  env.SWC_NATIVE_BINDING_CACHE = path.join(homedir(), ".cache", "swc-native");
  mkdirSync(env.SWC_NATIVE_BINDING_CACHE, { recursive: true });
}

function stopTestZotero() {
  if (process.platform !== "win32") return;
  const profile = path.join(root, ".scaffold", "test", "profile").replace(/'/g, "''");
  const script = `Get-CimInstance Win32_Process -Filter "Name='zotero.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${profile}') -and $_.CommandLine -notmatch 'contentproc' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $_.ProcessId }`;
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }).trim();
    if (out) console.log(`stopped leftover test Zotero: ${out.split(/\s+/).join(", ")}`);
  } catch {
    /* nothing to stop */
  }
}

const isTest = process.argv[2] === "test";
if (isTest) stopTestZotero();
const cli = path.join(root, "node_modules/zotero-plugin-scaffold/bin/zotero-plugin.mjs");
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: ["inherit", "pipe", "pipe"], env });
let finished = false;
let failed = false;
const watch = (src, dst) =>
  src.on("data", (buf) => {
    dst.write(buf);
    const text = buf.toString();
    if (isTest && /Test run completed - \d+ passed, \d+ failed/.test(text)) failed = true;
    if (isTest && !finished && /Test run completed/.test(text)) {
      finished = true;
      // Give the scaffold a moment to print the summary, then end the test Zotero.
      setTimeout(() => {
        stopTestZotero();
        setTimeout(() => child.kill(), 5000).unref();
      }, 1500);
    }
  });
watch(child.stdout, process.stdout);
watch(child.stderr, process.stderr);
child.on("exit", (code) => {
  if (isTest) stopTestZotero();
  process.exit(finished ? (failed ? 1 : 0) : (code ?? 1));
});
