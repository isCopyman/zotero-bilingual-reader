// "交给 Agent…": whole-paper translation by an agent the reader runs and watches. The panel
// gives the prompt and commands to copy, and shows what the plugin sees in the task folder.
// Also the small dialog that shows and edits the paper glossary.

import type { HandoffInfo, ZbrHost } from "../core/host-api";

interface Ctx {
  host: ZbrHost;
  toast(msg: string): void;
  /** Called when the toolbar status line should be redrawn. */
  onChange(): void;
}

let ctx: Ctx;
let info: HandoffInfo | null = null;
let panel: HTMLElement | null = null;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s} 秒前`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} 分钟前` : `${Math.round(m / 60)} 小时前`;
}

/** No new file for this long while unfinished: the agent may have stopped. */
const STALL_MS = 5 * 60_000;

/** One line about the task, from the files only. */
export function handoffStatus(h: HandoffInfo | null = info): string | null {
  if (!h) return null;
  const count = `${h.delivered}/${h.todo} 句`;
  const bad = h.bad ? `，${h.bad} 句未通过检查` : "";
  const last = h.lastWrite ? `，最后写入 ${ago(h.lastWrite)}` : "";
  const stalled = h.phase !== "done" && h.watching && Date.now() - (h.lastWrite ?? h.startedAt) > STALL_MS;
  const text = {
    waiting: "等待 Agent 开始（任务文件夹里还没有新文件）",
    glossary: "Agent 已定好术语表，正在翻译",
    translating: `Agent 翻译中：已交付 ${count}${bad}${last}`,
    checking: `已交付 ${count}${bad}，Agent 正在自查和写报告${last}`,
    done: h.delivered >= h.todo ? `Agent 已完成：${count}，报告已写好` : `Agent 已写报告，但只交付了 ${count}${bad}，可以生成补译提示词`,
  }[h.phase];
  const watch = h.watching || h.phase === "done" ? "" : "（已停止接收）";
  return `${text}${stalled ? "。超过 5 分钟没有新写入，请到 Agent 那边看看是否停了" : ""}${watch}`;
}

function copyRow(label: string, text: string): HTMLElement {
  const row = el("div", "ho-copy");
  const head = el("div", "ho-copy-head");
  const btn = el("button", "", "复制");
  btn.addEventListener("click", () => void navigator.clipboard.writeText(text).then(() => ctx.toast(`已复制${label}`)));
  head.append(el("span", "", label), btn);
  row.append(head, el("code", "", text));
  return row;
}

function render() {
  if (!panel || !info) return;
  const h = info;
  const body = panel.querySelector(".ho-body")!;
  const status = el("div", "ho-status", handoffStatus(h) ?? "");
  const actions = el("div", "ho-actions");
  const button = (label: string, fn: () => void, title = "") => {
    const b = el("button", "", label);
    if (title) b.title = title;
    b.addEventListener("click", fn);
    actions.append(b);
  };
  button("打开任务文件夹", () => void ctx.host.openHandoffFile("folder"));
  if (h.phase === "done") button("查看报告", () => void ctx.host.openHandoffFile("report"));
  if (h.phase === "done" || h.phase === "checking" || !h.watching) {
    if (h.delivered < h.todo)
      button("生成补译提示词", async () => {
        const p = await ctx.host.handoffFix();
        if (!p) ctx.toast("没有需要补译的句子");
      }, "把缺失或没通过检查的句子写成补译任务，交给同一个 Agent 会话");
  }
  if (h.watching) button("停止接收", () => void ctx.host.stopHandoff(), "不再读取任务文件夹（已导入的译文保留）");
  else if (h.phase !== "done") button("继续接收", () => void ctx.host.startHandoff());
  button("重新出题", async () => {
    if (!confirm("删除当前任务文件夹，按目前未翻译的句子重新出一份任务？")) return;
    try {
      await ctx.host.startHandoff({ fresh: true });
    } catch (e: any) {
      ctx.toast(e?.message ?? String(e));
    }
  });
  body.replaceChildren(
    el("p", "ho-intro", `插件已把这篇论文未翻译的 ${h.todo} 句和任务说明写进任务文件夹。把下面的提示词发给你自己打开的 Agent 会话（grok、Codex、Claude Code、codeg 都可以），或在终端里运行对应的命令。Agent 写出的译文会自动显示在页面上；关掉这个窗口不影响接收。`),
    copyRow("提示词", h.prompt),
    ...(h.fixPrompt ? [copyRow("补译提示词（发给同一个 Agent 会话）", h.fixPrompt)] : []),
    el("details", "ho-cmds"),
    status,
    actions,
  );
  const cmds = body.querySelector(".ho-cmds")!;
  cmds.append(el("summary", "", "终端命令（PowerShell，直接在任务文件夹里启动 Agent）"), ...h.commands.map((c) => copyRow(c.tool, c.line)));
}

function close() {
  panel?.remove();
  panel = null;
}

export function modal(title: string): HTMLElement {
  const back = el("div", "ho-back");
  const box = el("div", "ho-panel");
  const head = el("div", "ho-head");
  const x = el("button", "ho-x", "×");
  x.title = "关闭";
  head.append(el("b", "", title), x);
  box.append(head, el("div", "ho-body"));
  back.append(box);
  back.addEventListener("mousedown", (e) => {
    if (e.target === back) back.remove();
  });
  x.addEventListener("click", () => back.remove());
  document.body.append(back);
  return back;
}

export async function openHandoff() {
  close();
  try {
    info = await ctx.host.startHandoff();
  } catch (e: any) {
    ctx.toast(e?.message ?? String(e));
    return;
  }
  panel = modal("交给 Agent 整篇翻译");
  panel.querySelector(".ho-x")!.addEventListener("click", () => (panel = null));
  render();
  ctx.onChange();
}

export async function openGlossary() {
  const text = (await ctx.host.getPaperGlossary()) ?? "";
  const back = modal("本篇术语表");
  const body = back.querySelector(".ho-body")!;
  const ta = el("textarea", "ho-glossary");
  ta.value = text;
  ta.placeholder = "还没有生成：第一次分批翻译这篇论文时会自动生成。也可以直接在这里写，每行一条：English = 中文";
  const save = el("button", "", "保存");
  save.addEventListener("click", async () => {
    await ctx.host.setPaperGlossary(ta.value);
    ctx.toast("已保存本篇术语表（之后翻译的段落按它统一用词）");
    back.remove();
  });
  const actions = el("div", "ho-actions");
  actions.append(save);
  body.append(el("p", "ho-intro", "分批翻译时每一批都会带上这份术语表；设置里的全局术语表优先。修改后只影响之后翻译的段落，已经译好的可以选中后“重新翻译”。"), ta, actions);
}

export async function initHandoff(c: Ctx) {
  ctx = c;
  ctx.host.subscribe((ev) => {
    if (ev.type !== "handoff") return;
    info = ev.handoff;
    render();
    ctx.onChange();
  });
  info = await ctx.host.getHandoff();
  // "Last write n seconds ago" keeps moving while a task is open.
  setInterval(() => {
    if (info?.watching) {
      ctx.onChange();
      const s = panel?.querySelector(".ho-status");
      if (s) s.textContent = handoffStatus() ?? "";
    }
  }, 5000);
  ctx.onChange();
}
