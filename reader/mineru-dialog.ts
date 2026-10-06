// "MinerU 解析…": for readers without a MinerU setup of their own. Explains what MinerU adds,
// how to get a free API token, and runs the cloud parse through the host.

import type { ZbrHost } from "../core/host-api";
import { modal } from "./handoff";

const SITE = "https://mineru.net/apiManage/token";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

export async function openMineruDialog(host: ZbrHost, toast: (msg: string) => void, onDone: () => void) {
  const hasToken = (await host.mineruReady?.()) ?? false;
  const back = modal("用 MinerU 解析这篇论文");
  const body = back.querySelector(".ho-body")!;
  body.append(
    el("p", "ho-intro", "不解析也能正常阅读和翻译：正文用 Zotero 自带的文本，公式和表格从 PDF 截图显示。MinerU 解析之后，公式按 LaTeX 排版、可复制，表格可选中，正文也可以切换成 MinerU 版本。"),
  );
  const steps = el("ol", "mn-steps");
  const s1 = el("li");
  const link = el("a", "", "mineru.net");
  link.href = SITE;
  link.addEventListener("click", (e) => {
    e.preventDefault();
    host.openUrl?.(SITE);
  });
  s1.append("打开 ", link, " 注册并登录。");
  steps.append(s1, el("li", "", "进入“API 管理”，创建一个 API Token，复制下来。"), el("li", "", "粘贴到下面，点“保存并解析”。Token 只保存在本机 Zotero 设置里，以后在设置页也能改。"));
  body.append(steps);
  body.append(el("p", "ho-intro", "免费额度每天 1000 页（高优先级），单个文件不超过 200 页、200 MB。解析需要把 PDF 上传到 MinerU 的服务器，排队和解析通常要几分钟。"));
  const input = el("input", "mn-token");
  input.type = "password";
  input.placeholder = hasToken ? "已保存 Token（留空沿用）" : "粘贴 MinerU API Token";
  input.autocomplete = "off";
  const go = el("button", "", "保存并解析");
  const status = el("p", "ho-status");
  status.hidden = true;
  const actions = el("div", "ho-actions");
  actions.append(go);
  body.append(input, actions, status);
  input.focus();

  go.addEventListener("click", async () => {
    const token = input.value.trim();
    if (!token && !hasToken) {
      input.focus();
      toast("先粘贴 API Token");
      return;
    }
    if (token) await host.setMineruToken?.(token);
    go.disabled = true;
    input.disabled = true;
    status.hidden = false;
    status.textContent = "已提交，进度显示在工具栏；可以关闭这个窗口继续阅读。";
    try {
      await host.parseMineru!();
      toast("MinerU 解析完成：公式表格已用 LaTeX 重建，正文来源可切换为 MinerU");
      back.remove();
      onDone();
    } catch (e: any) {
      status.textContent = e?.message ?? String(e);
      go.disabled = false;
      input.disabled = false;
    }
  });
}
