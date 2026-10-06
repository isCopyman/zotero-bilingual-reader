// MinerU cloud parse (mineru.net precise-parse API v4) for users without a MinerU setup of their
// own: request an upload URL, PUT the PDF, poll until done, download the result zip and keep its
// content_list.json. Needs the user's API token (free daily quota on mineru.net).

import { hostFetch as fetch, setTimeout } from "./globals";

const API = "https://mineru.net/api/v4";
const POLL_MS = 4000;
const TIMEOUT_MS = 20 * 60_000;

export interface CloudProgress {
  state: string;
  pages?: number;
  total?: number;
}

async function api(token: string, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`MinerU 返回 HTTP ${res.status}：${text.slice(0, 200)}`);
  }
  if (!res.ok || body.code !== 0) {
    const hint = res.status === 401 || /A0202|A0211|token/i.test(String(body.msg)) ? "（API Token 无效或已过期，请在设置里重新填写）" : "";
    throw new Error(`MinerU：${body.msg ?? `HTTP ${res.status}`}${hint}`);
  }
  return body.data;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(() => r(), ms));

/** content_list.json of the PDF, parsed by MinerU's cloud service. */
export async function parseOnMineruCloud(opts: {
  token: string;
  pdf: Uint8Array;
  name: string;
  onProgress?: (p: CloudProgress) => void;
  signal?: AbortSignal;
}): Promise<unknown[]> {
  const { token, pdf, onProgress, signal } = opts;
  const name = opts.name.replace(/[\\/:*?"<>|]/g, "_").replace(/(\.pdf)?$/i, ".pdf");
  const batch = await api(token, "/file-urls/batch", {
    method: "POST",
    body: JSON.stringify({ files: [{ name }], model_version: "vlm", enable_formula: true, enable_table: true, language: "en" }),
  });
  onProgress?.({ state: "uploading" });
  const put = await fetch(batch.file_urls[0], { method: "PUT", body: pdf, signal });
  if (!put.ok) throw new Error(`上传 PDF 失败：HTTP ${put.status}`);

  const t0 = Date.now();
  let zipUrl = "";
  while (!zipUrl) {
    signal?.throwIfAborted();
    if (Date.now() - t0 > TIMEOUT_MS) throw new Error("MinerU 解析超时（20 分钟），稍后可再试");
    await sleep(POLL_MS);
    const r = await api(token, `/extract-results/batch/${batch.batch_id}`);
    const item = r.extract_result?.[0];
    if (!item) continue;
    if (item.state === "failed") throw new Error(`MinerU 解析失败：${item.err_msg || "未知原因"}`);
    if (item.state === "done") zipUrl = item.full_zip_url;
    else onProgress?.({ state: item.state, pages: item.extract_progress?.extracted_pages, total: item.extract_progress?.total_pages });
  }

  onProgress?.({ state: "downloading" });
  const zipRes = await fetch(zipUrl, { signal });
  if (!zipRes.ok) throw new Error(`下载解析结果失败：HTTP ${zipRes.status}`);
  const zipPath = PathUtils.join(PathUtils.tempDir, `zbr-mineru-${Date.now()}.zip`);
  await IOUtils.write(zipPath, new Uint8Array(await zipRes.arrayBuffer()));
  try {
    const reader = (Components.classes as any)["@mozilla.org/libjar/zip-reader;1"].createInstance(Components.interfaces.nsIZipReader);
    reader.open(Zotero.File.pathToFile(zipPath));
    try {
      const entries = reader.findEntries("*content_list.json");
      let entry = "";
      while (entries.hasMore()) {
        const e = entries.getNext();
        // The v2 list (content_list_v2.json) has another shape; take the plain one.
        if (/(^|\/)[^/]*_content_list\.json$/.test(e) || /(^|\/)content_list\.json$/.test(e)) entry = e;
      }
      if (!entry) throw new Error("解析结果里没有 content_list.json");
      const out = PathUtils.join(PathUtils.tempDir, `zbr-mineru-${Date.now()}.json`);
      reader.extract(entry, Zotero.File.pathToFile(out));
      try {
        return (await IOUtils.readJSON(out)) as unknown[];
      } finally {
        await IOUtils.remove(out).catch(() => {});
      }
    } finally {
      reader.close();
    }
  } finally {
    await IOUtils.remove(zipPath).catch(() => {});
  }
}
