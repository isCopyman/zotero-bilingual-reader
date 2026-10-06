// Background pre-translation of papers chosen in the library ("预翻译"): each paper is
// translated in full with the reader's current engine, without opening a tab, so it shows
// translated when it is opened. The Zotero text comes first; when the paper has a MinerU parse,
// the sentences only that text has follow (most sentences are shared through the cache).

import type { HostEvent, TranslationProgress } from "../../core/host-api";
import { createHost } from "./host";
import { resolveAttachment } from "./tab";

interface Job {
  attachment: any;
  title: string;
}

const queue: Job[] = [];
let running = false;
let stopped = false;
let current: ReturnType<typeof createHost> | null = null;
let summary = { papers: 0, done: 0, sentences: 0, failed: 0 };
let win: any = null;
let line: any = null;

export const isPrefetching = () => running;

function titleOf(attachment: any): string {
  const parent = attachment.parentItem;
  return String((parent ?? attachment).getField?.("title") || attachment.attachmentFilename || "PDF");
}

function show(text: string, pct?: number) {
  if (!win) {
    win = new (Zotero as any).ProgressWindow({ closeOnClick: false });
    win.changeHeadline("双语阅读 · 预翻译");
    line = new win.ItemProgress("chrome://zotero/skin/attachment-pdf.svg", text);
    win.show();
  }
  line.setText(text);
  if (pct !== undefined) line.setProgress(Math.max(1, Math.min(100, Math.round(pct))));
}

function finish(text: string) {
  show(text, 100);
  win?.startCloseTimer(10_000);
  win = null;
  line = null;
}

/** Translate everything still missing in one source of one paper; resolves when the queue is empty. */
async function runSource(job: Job, source: "zotero" | "mineru", index: number): Promise<TranslationProgress | null> {
  const host = createHost(job.attachment, { source });
  current = host;
  try {
    const doc = await host.getDocument();
    if (source === "mineru" && doc.parser.kind !== "mineru") return null;
    let last: TranslationProgress = { running: false, done: 0, total: 0, failed: 0 };
    let started = false;
    const finished = new Promise<void>((resolve) => {
      host.subscribe((ev: HostEvent) => {
        if (ev.type !== "progress") return;
        last = ev.progress;
        if (last.running) started = true;
        const which = source === "mineru" ? "（MinerU）" : "";
        show(`${index}/${summary.papers} ${job.title.slice(0, 40)}${which}：${last.done}/${last.total} 句${last.failed ? `，失败 ${last.failed}` : ""}`, last.total ? (last.done / last.total) * 100 : undefined);
        if (started && !last.running) resolve();
      });
    });
    await host.translate({ all: true });
    // Nothing to do: the request finishes without ever running.
    if (!host.getProgressSnapshot().running) return host.getProgressSnapshot();
    await finished;
    return last;
  } finally {
    current = null;
    host.dispose();
  }
}

async function run() {
  running = true;
  stopped = false;
  let index = 0;
  try {
    while (queue.length && !stopped) {
      const job = queue.shift()!;
      index++;
      show(`${index}/${summary.papers} ${job.title.slice(0, 40)}：准备中…`);
      try {
        for (const source of ["zotero", "mineru"] as const) {
          if (stopped) break;
          const p = await runSource(job, source, index);
          if (p) {
            summary.sentences += p.done;
            summary.failed += p.failed;
          }
        }
        summary.done++;
      } catch (e: any) {
        Zotero.logError(e);
        show(`${index}/${summary.papers} ${job.title.slice(0, 40)}：${e?.message ?? e}`);
      }
    }
    finish(
      stopped
        ? `已停止：完成 ${summary.done}/${summary.papers} 篇`
        : `完成 ${summary.done}/${summary.papers} 篇，新译 ${summary.sentences} 句${summary.failed ? `，失败 ${summary.failed} 句（打开论文后可重试）` : ""}`,
    );
  } finally {
    running = false;
    queue.length = 0;
  }
}

/** Add papers (items or their PDFs) to the queue; starts the run if idle. */
export async function prefetch(items: any[]) {
  if (!running) summary = { papers: 0, done: 0, sentences: 0, failed: 0 };
  const seen = new Set(queue.map((j) => j.attachment.id));
  for (const item of items) {
    const attachment = await resolveAttachment(item);
    if (!attachment || seen.has(attachment.id)) continue;
    seen.add(attachment.id);
    queue.push({ attachment, title: titleOf(attachment) });
    summary.papers++;
  }
  if (!summary.papers) return;
  if (!running) void run();
  else show(`已加入队列，共 ${summary.papers} 篇`);
}

export function stopPrefetch() {
  stopped = true;
  queue.length = 0;
  void current?.cancel();
}
