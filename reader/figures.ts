// Crops figures, tables and display math out of the original PDF with pdf.js.

import katex from "katex";
import type { RichStyle, ZbrHost } from "../core/host-api";
import type { Enrichment } from "../core/mineru";
import type { Block } from "../core/model";

type PdfDoc = any;

let pdfPromise: Promise<PdfDoc> | null = null;
const pageCanvasCache = new Map<string, Promise<HTMLCanvasElement>>();
const MAX_CACHED_PAGES = 4;
/** Render scale for inline figure crops (CSS px per PDF pt before max-width shrinking). */
export const CROP_SCALE = 2.5;


function loadPdf(host: ZbrHost): Promise<PdfDoc> {
  if (!pdfPromise) {
    pdfPromise = (async () => {
      const pdfjs = await import(/* webpackIgnore: true */ host.pdfjs.lib);
      pdfjs.GlobalWorkerOptions.workerSrc = host.pdfjs.worker;
      const data = await host.getPdfData();
      return pdfjs.getDocument({ data, isEvalSupported: false }).promise;
    })();
  }
  return pdfPromise;
}

async function renderPage(host: ZbrHost, pageIndex: number, scale: number): Promise<HTMLCanvasElement> {
  const key = `${pageIndex}@${scale}`;
  let p = pageCanvasCache.get(key);
  if (!p) {
    p = (async () => {
      const pdf = await loadPdf(host);
      const page = await pdf.getPage(pageIndex + 1);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const t0 = performance.now();
      await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
      performance.measure("zbr-pdf-page", { start: t0 });
      (canvas as any)._viewport = viewport;
      return canvas;
    })();
    pageCanvasCache.set(key, p);
    if (pageCanvasCache.size > MAX_CACHED_PAGES) {
      const first = pageCanvasCache.keys().next().value!;
      pageCanvasCache.delete(first);
    }
  }
  return p;
}

/** Union of the block's rects on its first page, in PDF user space, padded. */
export function cropRect(block: Block): { pageIndex: number; rect: [number, number, number, number] } | null {
  if (!block.pageRects.length) return null;
  const pageIndex = block.pageRects[0][0];
  const rs = block.pageRects.filter((r) => r[0] === pageIndex);
  const pad = 3;
  return {
    pageIndex,
    rect: [
      Math.min(...rs.map((r) => r[1])) - pad,
      Math.min(...rs.map((r) => r[2])) - pad,
      Math.max(...rs.map((r) => r[3])) + pad,
      Math.max(...rs.map((r) => r[4])) + pad,
    ],
  };
}

/** Finished crops as object URLs, so re-renders (mode switches) reuse them. */
const cropCache = new Map<string, Promise<string | null>>();

export function renderCrop(host: ZbrHost, block: Block, scale: number): Promise<string | null> {
  const key = `${block.id}@${scale}`;
  let p = cropCache.get(key);
  if (!p) {
    p = cropToUrl(host, block, scale);
    cropCache.set(key, p);
    p.catch(() => cropCache.delete(key));
  }
  return p;
}

async function cropToUrl(host: ZbrHost, block: Block, scale: number): Promise<string | null> {
  const crop = cropRect(block);
  if (!crop) return null;
  const page = await renderPage(host, crop.pageIndex, scale);
  const vp = (page as any)._viewport;
  const [ax, ay, bx, by] = vp.convertToViewportRectangle(crop.rect);
  const x = Math.max(0, Math.floor(Math.min(ax, bx)));
  const y = Math.max(0, Math.floor(Math.min(ay, by)));
  const w = Math.min(page.width - x, Math.ceil(Math.abs(bx - ax)));
  const h = Math.min(page.height - y, Math.ceil(Math.abs(by - ay)));
  if (w <= 2 || h <= 2) return null;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out.getContext("2d")!.drawImage(page, x, y, w, h, 0, 0, w, h);
  // toBlob encodes off the main thread; toDataURL would block scrolling for large figures.
  const blob = await new Promise<Blob | null>((r) => out.toBlob(r, "image/png"));
  return blob ? URL.createObjectURL(blob) : null;
}

export interface FigureCtx {
  host: ZbrHost;
  root: HTMLElement;
  blocks: Map<string, Block>;
  enrich: Record<string, Enrichment> | null;
  getRich(): RichStyle;
  toast(msg: string): void;
}

const TABLE_TAGS = new Set(["TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TD", "TH", "CAPTION", "COLGROUP", "COL", "BR", "SUB", "SUP", "B", "I", "EM", "STRONG"]);

/** MinerU's table HTML is untrusted text: rebuild it keeping only table structure. */
export function sanitizeTable(html: string): HTMLTableElement | null {
  const src = new DOMParser().parseFromString(html, "text/html").querySelector("table");
  if (!src) return null;
  const copy = (from: Element, to: Element) => {
    for (const child of Array.from(from.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) to.append(child.textContent ?? "");
      else if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element;
        if (!TABLE_TAGS.has(el.tagName)) {
          copy(el, to);
          continue;
        }
        const out = document.createElement(el.tagName.toLowerCase());
        for (const attr of ["rowspan", "colspan"]) {
          const v = el.getAttribute(attr);
          if (v && /^\d{1,3}$/.test(v)) out.setAttribute(attr, v);
        }
        copy(el, out);
        to.append(out);
      }
    }
  };
  const table = document.createElement("table");
  copy(src, table);
  return table;
}

function tableToTsv(table: HTMLTableElement): string {
  return Array.from(table.rows)
    .map((r) => Array.from(r.cells).map((c) => c.textContent?.trim() ?? "").join("\t"))
    .join("\n");
}

function figTools(ctx: FigureCtx, block: Block, copyLabel: string, copyText: string): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "fig-tools";
  const copy = document.createElement("button");
  copy.textContent = copyLabel;
  copy.addEventListener("click", (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(copyText).then(() => ctx.toast(`已${copyLabel}`));
  });
  const orig = document.createElement("button");
  orig.textContent = "原图";
  orig.title = "查看原 PDF 中的这一块";
  orig.addEventListener("click", (e) => {
    e.stopPropagation();
    openLightbox(ctx.host, block);
  });
  bar.append(copy, orig);
  return bar;
}

/** Rebuild a math/table block from MinerU. Returns false when there is nothing to show. */
function renderRich(ctx: FigureCtx, fig: HTMLElement, block: Block): boolean {
  const e = ctx.enrich?.[block.id];
  if (!e) return false;
  if (e.coveredBy) {
    fig.closest("section.blk")?.classList.add("covered");
    return true;
  }
  if (e.latex) {
    const box = document.createElement("div");
    box.className = "tex-body";
    const t0 = performance.now();
    try {
      katex.render(e.latex, box, { displayMode: true, throwOnError: false, strict: "ignore", trust: false, output: "htmlAndMathml" });
    } catch {
      return false;
    } finally {
      performance.measure("zbr-katex", { start: t0 });
    }
    box.title = "点击复制 LaTeX";
    box.addEventListener("click", () => navigator.clipboard.writeText(e.latex!).then(() => ctx.toast("已复制 LaTeX")));
    fig.classList.add("tex");
    fig.classList.remove("sized");
    fig.replaceChildren(box, figTools(ctx, block, "复制 LaTeX", e.latex));
    return true;
  }
  if (e.tableHtml) {
    const table = sanitizeTable(e.tableHtml);
    if (!table) return false;
    const wrap = document.createElement("div");
    wrap.className = "table-body";
    wrap.append(table);
    fig.classList.add("html-table");
    fig.classList.remove("sized");
    fig.replaceChildren(wrap, figTools(ctx, block, "复制表格", tableToTsv(table)));
    return true;
  }
  return false;
}

function renderFigure(ctx: FigureCtx, fig: HTMLElement, block: Block) {
  if (ctx.getRich() === "mineru" && renderRich(ctx, fig, block)) return;
  fig.classList.add("loading");
  renderCrop(ctx.host, block, CROP_SCALE)
    .then((url) => {
      fig.classList.remove("loading");
      if (!url) {
        fig.classList.add("missing");
        fig.textContent = block.kind === "math" ? block.text : "（图像不可用）";
        return;
      }
      const img = document.createElement("img");
      img.src = url;
      img.alt = block.kind;
      img.addEventListener("click", () => openLightbox(ctx.host, block));
      fig.replaceChildren(img);
      fig.classList.remove("sized");
      if (block.kind === "math") fig.classList.add("math");
    })
    .catch((err) => {
      fig.classList.remove("loading");
      fig.classList.add("missing");
      fig.textContent = `（渲染失败：${err?.message ?? err}）`;
    });
}

/** Lazily render figures as they approach the viewport. */
export function observeFigures(ctx: FigureCtx) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const target = e.target as HTMLElement;
        io.unobserve(target);
        const fig = target.matches("figure.fig") ? target : target.querySelector<HTMLElement>("figure.fig");
        const block = fig && ctx.blocks.get(fig.dataset.b!);
        if (fig && block) renderFigure(ctx, fig, block);
      }
    },
    { root: null, rootMargin: "800px 0px" },
  );
  // Observe the block section, which always has a box (the figure may be empty until rendered).
  ctx.root.querySelectorAll<HTMLElement>("figure.fig").forEach((f) => io.observe(f.closest<HTMLElement>("section.blk") ?? f));
  return io;
}

export async function openLightbox(host: ZbrHost, block: Block) {
  const overlay = document.createElement("div");
  overlay.className = "lightbox";
  const img = document.createElement("img");
  overlay.append(img);
  const hint = document.createElement("div");
  hint.className = "lb-hint";
  hint.textContent = "滚轮缩放 · 拖动平移 · Esc 或点击空白关闭";
  overlay.append(hint);
  document.body.append(overlay);
  let scale = 1;
  let tx = 0;
  let ty = 0;
  const apply = () => (img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`);
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", (e) => e.target === overlay && close());
  overlay.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      scale = Math.min(8, Math.max(0.3, scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      apply();
    },
    { passive: false },
  );
  let drag: { x: number; y: number } | null = null;
  img.addEventListener("mousedown", (e) => {
    drag = { x: e.clientX - tx, y: e.clientY - ty };
    e.preventDefault();
  });
  overlay.addEventListener("mousemove", (e) => {
    if (!drag) return;
    tx = e.clientX - drag.x;
    ty = e.clientY - drag.y;
    apply();
  });
  overlay.addEventListener("mouseup", () => (drag = null));
  img.src = (await renderCrop(host, block, 5)) ?? "";
}
