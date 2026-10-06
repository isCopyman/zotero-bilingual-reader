// One floating button beside the paragraph under the mouse: translate it, retranslate it, or retry
// its failed sentences. A single element follows the hover, so long papers carry no per-paragraph
// controls and re-rendering the page never has to rebuild them.

import type { Block } from "../core/model";
import { isBlockTranslated, translationFor, type Translations } from "./render";

export interface BlockActionCtx {
  root: HTMLElement;
  blocks: Map<string, Block>;
  getTranslations(): Translations;
  /** Failed sentence ids (unit id -> reason). */
  failed: Map<string, string>;
  translate(blockId: string, retranslate: boolean): Promise<void>;
  /** Whether the scheduler is translating anything right now. */
  isRunning(): boolean;
  toast(msg: string): void;
}

type Kind = "translate" | "retranslate" | "retry" | "busy";

const ICONS: Record<Kind, string> = {
  // 文 in a speech bubble
  translate: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 4.5h14v9H9l-4 3v-3H3z"/><text x="10" y="11.8" font-size="7" text-anchor="middle" fill="currentColor" stroke="none" font-family="sans-serif">译</text></svg>`,
  retranslate: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M15.5 8A6 6 0 1 0 16 12"/><path d="M16 3.5V8h-4.5"/></svg>`,
  retry: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M15.5 8A6 6 0 1 0 16 12"/><path d="M16 3.5V8h-4.5"/><circle cx="10" cy="10" r="1.3" fill="currentColor" stroke="none"/></svg>`,
  busy: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10 3a7 7 0 1 1-7 7"/></svg>`,
};

const TITLES: Record<Kind, string> = {
  translate: "翻译这一段",
  retranslate: "用当前引擎重新翻译这一段",
  retry: "重试这一段里翻译失败的句子",
  busy: "翻译中…",
};

export function installBlockAction(ctx: BlockActionCtx) {
  const btn = document.createElement("button");
  btn.id = "blk-action";
  btn.type = "button";
  btn.hidden = true;
  document.body.append(btn);
  /** Paragraphs sent from this button -> their sentences not answered yet. */
  const busy = new Map<string, Set<string>>();
  let current: HTMLElement | null = null;

  function kindOf(id: string): Kind {
    const b = ctx.blocks.get(id)!;
    if (busy.has(id)) return "busy";
    if (b.sentences.some((s) => ctx.failed.has(s.id))) return "retry";
    return isBlockTranslated(b, ctx.getTranslations()) ? "retranslate" : "translate";
  }

  function show(section: HTMLElement) {
    current = section;
    const kind = kindOf(section.dataset.b!);
    btn.className = `k-${kind}`;
    btn.innerHTML = ICONS[kind];
    btn.title = TITLES[kind];
    btn.setAttribute("aria-label", TITLES[kind]);
    // In the page's right margin, level with the paragraph's first line. Positioned in page
    // coordinates, so scrolling moves it with the text without any scroll handler.
    const r = section.getBoundingClientRect();
    const doc = ctx.root.getBoundingClientRect();
    btn.style.top = `${r.top + window.scrollY + 2}px`;
    btn.style.left = `${Math.min(doc.right - 28, r.right + 6) + window.scrollX}px`;
    btn.hidden = false;
  }

  function hide() {
    current = null;
    btn.hidden = true;
  }

  ctx.root.addEventListener("mouseover", (e) => {
    const section = (e.target as Element).closest<HTMLElement>("section.blk");
    if (!section || section === current) return;
    if (!ctx.blocks.get(section.dataset.b!)?.translatable) return hide();
    show(section);
  });
  document.addEventListener("mouseover", (e) => {
    const t = e.target as Node;
    if (t !== btn && !btn.contains(t) && !ctx.root.contains(t)) hide();
  });

  btn.addEventListener("click", () => {
    const id = current?.dataset.b;
    if (!id) return;
    const kind = kindOf(id);
    if (kind === "busy") return;
    const b = ctx.blocks.get(id)!;
    const tr = ctx.getTranslations();
    const wait = b.sentences.filter((s) => kind === "retranslate" || ctx.failed.has(s.id) || translationFor(s, tr) === undefined).map((s) => s.id);
    busy.set(id, new Set(wait));
    show(current!);
    ctx.translate(id, kind === "retranslate").then(() => {
      // Nothing was queued (already translated elsewhere): no result will come back.
      if (!ctx.isRunning()) refresh([], false);
    }, (err) => {
      busy.delete(id);
      ctx.toast(`翻译失败：${err?.message ?? err}`);
      refresh();
    });
  });

  /**
   * Call with the sentence ids of each translations event (translated or failed), or with
   * running=false once the scheduler is idle: answered paragraphs leave the busy set.
   */
  function refresh(answered: string[] = [], running = true) {
    for (const u of answered) {
      const id = u.slice(0, u.lastIndexOf(":"));
      const wait = busy.get(id);
      if (!wait) continue;
      wait.delete(u);
      if (!wait.size) busy.delete(id);
    }
    if (!running) busy.clear();
    if (current) show(current);
  }

  return { refresh, hide };
}
