// Settings pane: one card per local agent (status, model, reasoning effort, test, program path),
// built at load time from what the tools themselves report on this machine.

import { runBatch } from "../../core/translate/runner";
import { API_EFFORTS, engineIdOf, fetchModels, LOCAL_CPA, loadProviders, newId, saveProviders, type ApiProvider } from "./api-providers";
import { getEngine, listEngines, modelChoices, resetDetection, toolDefaults, type ModelChoice } from "./engines";
import { getPref, setPref } from "./prefs";
import { cacheDir } from "./store";

const HTML = "http://www.w3.org/1999/xhtml";
const EFFORT_LABELS: Record<string, string> = { none: "不思考", minimal: "最少", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高", ultra: "极高" };
const effortText = (e: string) => (EFFORT_LABELS[e] ? `${EFFORT_LABELS[e]}（${e}）` : e);
const CUSTOM = "__custom__";

const AGENTS = [
  { name: "grok", id: "agent:grok", title: "Grok Build", tool: "grok", path: "%USERPROFILE%\\.grok\\bin\\grok.exe" },
  { name: "codex", id: "agent:codex", title: "Codex CLI", tool: "Codex", path: "npm 安装的 codex，或 Codex 桌面应用自带的 codex.exe" },
  { name: "claude", id: "agent:claude", title: "Claude Code", tool: "Claude Code", path: "%USERPROFILE%\\.local\\bin\\claude.exe" },
] as const;

function h<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, props: Record<string, any> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = doc.createElementNS(HTML, tag) as HTMLElementTagNameMap[K];
  for (const [k, v] of Object.entries(props)) {
    if (k === "style") el.setAttribute("style", v);
    else (el as any)[k] = v;
  }
  el.append(...children);
  return el;
}

/**
 * A XUL menulist: HTML <select> popups do not open inside Zotero's settings window.
 */
function menu(doc: Document, items: [string, string][] = []): any {
  const ml = (doc as any).createXULElement("menulist");
  ml.setAttribute("style", "flex:none;width:24em");
  ml.appendChild((doc as any).createXULElement("menupopup"));
  setItems(ml, items);
  return ml;
}

function setItems(ml: any, items: [string, string][]) {
  ml.removeAllItems();
  for (const [value, label] of items) ml.appendItem(label, value);
}

/** Translate one sentence the way the reader would; reports time and result. */
async function testEngine(id: string, show: (text: string) => void) {
  show("测试中…（命令行工具第一次启动可能要十几秒）");
  resetDetection();
  const t0 = Date.now();
  try {
    const { engine } = await getEngine(id);
    const en = "Wind power forecasting reduces the reserve cost of power systems.";
    const batch = { paragraphs: [{ blockId: "t", kind: "paragraph", units: [{ id: "t:0", en }], fullText: en, totalUnits: 1 }], ids: ["t:0"], chars: en.length };
    const r = await runBatch(engine, batch as any, {}, 0);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const zh = r.ok["t:0"];
    show(zh ? `✓ ${secs} 秒：${zh}` : `✗ ${secs} 秒：${r.problems.at(-1) ?? "没有返回译文"}`);
  } catch (e: any) {
    show(`✗ ${e?.message ?? e}`);
  }
}

async function buildAgentCards(doc: Document) {
  const box = doc.getElementById("zbr-agents");
  if (!box) return;
  const [choices, defaults] = await Promise.all([modelChoices(), toolDefaults()]);
  const statusOf = new Map<string, HTMLElement>();
  box.replaceChildren(
    ...AGENTS.map((a) => {
      const models: ModelChoice[] = choices[a.name];
      const def = defaults[a.name];
      const label = (text: string) => h(doc, "span", { textContent: text, style: "flex:none;width:5em;color:var(--fill-secondary,#666)" });
      const row = (...c: (Node | string)[]) => h(doc, "div", { style: "display:flex;align-items:center;gap:8px;margin:4px 0" }, ...c);

      // Model: the tool's own default, its listed models, or any name typed in.
      const modelSel = menu(doc, [
        ["", `跟随 ${a.tool} 自己的设置${def.model ? `（${def.model}）` : ""}`],
        ...models.map((m): [string, string] => [m.id, m.label]),
        [CUSTOM, "自定义…"],
      ]);
      const custom = h(doc, "input", { type: "text", placeholder: "输入模型名", style: "width:14em" });
      const saved = String(getPref(`${a.name}Model`) || "");
      const known = !saved || models.some((m) => m.id === saved);
      modelSel.value = known ? saved : CUSTOM;
      custom.value = known ? "" : saved;
      custom.hidden = known;

      const effortSel = menu(doc);
      const fillEfforts = () => {
        const id = modelSel.value === CUSTOM ? custom.value.trim() : modelSel.value || def.model || "";
        const m = models.find((x) => x.id === id);
        const levels = m?.efforts.length ? m.efforts : [...new Set(models.flatMap((x) => x.efforts))];
        const current = String(getPref(`${a.name}Effort`) || "");
        // With the model left to the tool, its configured effort applies; otherwise the model's own default.
        const fallback = modelSel.value ? m?.defaultEffort : (def.effort ?? m?.defaultEffort);
        setItems(effortSel, [["", `跟随 ${a.tool} 自己的设置${fallback ? `（${effortText(fallback)}）` : ""}`], ...levels.map((l): [string, string] => [l, effortText(l)])]);
        effortSel.value = levels.includes(current) ? current : "";
        if (effortSel.value !== current) setPref(`${a.name}Effort`, effortSel.value);
      };
      const saveModel = () => {
        custom.hidden = modelSel.value !== CUSTOM;
        setPref(`${a.name}Model`, modelSel.value === CUSTOM ? custom.value.trim() : modelSel.value);
        fillEfforts();
      };
      modelSel.addEventListener("command", () => {
        saveModel();
        if (!custom.hidden) custom.focus();
      });
      custom.addEventListener("change", saveModel);
      effortSel.addEventListener("command", () => setPref(`${a.name}Effort`, effortSel.value));
      fillEfforts();

      const status = h(doc, "span", { className: "zbr-status", textContent: "检测中…", style: "color:var(--fill-secondary,#666);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1" });
      status.dataset.engine = a.id;
      statusOf.set(a.id, status);
      const out = h(doc, "div", { style: "color:var(--fill-secondary,#666);margin:2px 0 0 5em;white-space:pre-wrap" });
      const test = h(doc, "button", { textContent: "测试", title: "用当前模型和思考强度翻译一句话" });
      test.addEventListener("click", () => void testEngine(a.id, (t) => (out.textContent = t)));

      const path = h(doc, "input", { type: "text", placeholder: `留空自动检测（${a.path}）`, value: String(getPref(`${a.name}Path`) || ""), style: "flex:1" });
      path.addEventListener("change", () => {
        setPref(`${a.name}Path`, path.value.trim());
        void refreshStatus(statusOf);
      });
      const advanced = h(doc, "details", {}, h(doc, "summary", { textContent: "程序路径（一般不用改）", style: "cursor:pointer;color:var(--fill-secondary,#666)" }), row(label("路径"), path));

      return h(
        doc,
        "div",
        { className: "zbr-agent", style: "border:1px solid var(--fill-quinary,#ddd);border-radius:6px;padding:8px 12px;margin:8px 0" },
        row(h(doc, "b", { textContent: a.title, style: "min-width:7em" }), status, test),
        row(label("模型"), modelSel, custom),
        row(label("思考强度"), effortSel, h(doc, "span", { textContent: "翻译选“中”或“低”即可，越高越慢", style: "color:var(--fill-secondary,#666)" })),
        advanced,
        out,
      );
    }),
  );
  await refreshStatus(statusOf);
}

/** One card per API provider: endpoint, key, request limit, effort and the models to offer. */
function buildApiCards(doc: Document) {
  const box = doc.getElementById("zbr-apis");
  if (!box) return;
  let list = loadProviders();
  const save = () => saveProviders(list);
  const label = (text: string) => h(doc, "span", { textContent: text, style: "flex:none;width:6em;color:var(--fill-secondary,#666)" });
  const row = (...c: (Node | string)[]) => h(doc, "div", { style: "display:flex;align-items:center;gap:8px;margin:4px 0" }, ...c);

  const card = (p: ApiProvider) => {
    const field = (key: "name" | "base" | "key", type: string, placeholder = "") => {
      const input = h(doc, "input", { type, value: p[key], placeholder, style: "flex:1" });
      input.addEventListener("change", () => {
        p[key] = input.value.trim();
        save();
      });
      return input;
    };
    const conc = h(doc, "input", { type: "number", min: "1", max: "64", value: String(p.concurrency), style: "width:5em" });
    conc.addEventListener("change", () => {
      p.concurrency = Math.min(64, Math.max(1, Number(conc.value) || 8));
      save();
    });
    const effortSel = menu(doc, API_EFFORTS.map((e): [string, string] => [e, e ? effortText(e) : "不指定（用模型默认）"]));
    effortSel.setAttribute("style", "flex:none;width:14em");
    effortSel.value = p.effort;
    effortSel.addEventListener("command", () => {
      p.effort = effortSel.value;
      save();
    });

    // Models: ticked ones become engines. The list comes from the endpoint or is typed in.
    const models = h(doc, "div", { className: "zbr-api-models", style: "display:flex;flex-wrap:wrap;gap:4px 14px;margin:2px 0 2px 6em;max-height:12em;overflow:auto" });
    let known: string[] = [...p.models];
    const drawModels = () => {
      models.replaceChildren(
        ...[...new Set([...p.models, ...known])].map((m) => {
          const cb = h(doc, "input", { type: "checkbox", checked: p.models.includes(m) });
          cb.dataset.model = m;
          cb.addEventListener("change", () => {
            p.models = cb.checked ? [...p.models, m] : p.models.filter((x) => x !== m);
            save();
          });
          return h(doc, "label", { style: "display:flex;align-items:center;gap:3px;white-space:nowrap" }, cb, m);
        }),
      );
      if (!models.childNodes.length) models.append(h(doc, "span", { textContent: "还没有模型：点“获取模型列表”，或在右边输入模型名后添加", style: "color:var(--fill-secondary,#666)" }));
    };
    drawModels();
    const out = h(doc, "div", { style: "color:var(--fill-secondary,#666);margin:2px 0 0 6em;white-space:pre-wrap" });
    const fetchBtn = h(doc, "button", { textContent: "获取模型列表" });
    fetchBtn.addEventListener("click", async () => {
      out.textContent = "获取中…";
      try {
        known = await fetchModels(p.base, p.key);
        out.textContent = `共 ${known.length} 个模型，勾选要用的`;
        drawModels();
      } catch (e: any) {
        out.textContent = `✗ ${e?.message ?? e}`;
      }
    });
    const typed = h(doc, "input", { type: "text", placeholder: "模型名", style: "width:12em" });
    const addBtn = h(doc, "button", { textContent: "添加" });
    addBtn.addEventListener("click", () => {
      const m = typed.value.trim();
      if (!m) return;
      if (!p.models.includes(m)) p.models = [...p.models, m];
      typed.value = "";
      save();
      drawModels();
    });
    const test = h(doc, "button", { textContent: "测试", title: "用勾选的第一个模型翻译一句话" });
    test.addEventListener("click", () => {
      if (!p.models.length) return void (out.textContent = "先勾选或添加一个模型");
      void testEngine(engineIdOf(p, p.models[0]), (t) => (out.textContent = `${p.models[0]}：${t}`));
    });
    const remove = h(doc, "button", { textContent: "删除服务商" });
    remove.addEventListener("click", () => {
      list = list.filter((x) => x !== p);
      save();
      draw();
    });
    return h(
      doc,
      "div",
      { className: "zbr-api", style: "border:1px solid var(--fill-quinary,#ddd);border-radius:6px;padding:8px 12px;margin:8px 0" },
      row(label("名称"), field("name", "text"), test, remove),
      row(label("Base URL"), field("base", "text", "https://api.openai.com/v1")),
      row(label("API Key"), field("key", "password")),
      row(label("同时请求"), conc, label("思考强度"), effortSel),
      row(label("模型"), fetchBtn, typed, addBtn),
      models,
      out,
    );
  };
  const draw = () => box.replaceChildren(...list.map(card));
  draw();
  const add = (preset: Partial<ApiProvider>) => {
    list = [...list, { id: newId(list), name: "API", base: "", key: "", models: [], concurrency: 8, effort: "", ...preset }];
    save();
    draw();
  };
  doc.getElementById("zbr-api-add")?.addEventListener("command", () => add({ name: `API ${list.length + 1}`, base: "https://api.openai.com/v1" }));
  doc.getElementById("zbr-api-add-cpa")?.addEventListener("command", () => add({ ...LOCAL_CPA, models: [...LOCAL_CPA.models] }));
  // Saving once turns migrated single-API settings into the list.
  if (list.length && !getPref("apiProviders")) save();
}

async function refreshStatus(statusOf: Map<string, HTMLElement>) {
  resetDetection();
  for (const e of await listEngines()) {
    const el = statusOf.get(e.id);
    if (!el) continue;
    el.textContent = e.ready ? `✓ 已找到：${e.note}` : `✗ ${e.note}`;
    el.title = e.note ?? "";
  }
  return statusOf;
}

export function onPrefsLoad(win: Window) {
  const doc = win.document;
  const cards = buildAgentCards(doc).catch((e) => Zotero.logError(e));
  doc.getElementById("zbr-detect")?.addEventListener("command", async () => {
    await cards;
    const statusOf = new Map<string, HTMLElement>();
    doc.querySelectorAll<HTMLElement>(".zbr-status").forEach((s) => statusOf.set(s.dataset.engine!, s));
    await refreshStatus(statusOf);
  });
  try {
    buildApiCards(doc);
  } catch (e) {
    Zotero.logError(e as Error);
  }
  doc.getElementById("zbr-open-cache")?.addEventListener("command", async () => {
    const dir = cacheDir();
    await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
    Zotero.File.reveal(dir);
  });
}
