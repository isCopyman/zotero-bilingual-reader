// The "frame" pair mark: one outline around the marked sentences of a paragraph in each language,
// following the text's shape (first line from where it starts, last line to where it ends),
// instead of a box around every sentence and every wrapped line.

const SVG = "http://www.w3.org/2000/svg";
const PAD = 2;

let layer: SVGSVGElement | null = null;

function ensureLayer(): SVGSVGElement {
  if (layer?.isConnected) return layer;
  layer = document.createElementNS(SVG, "svg");
  layer.id = "pair-frame";
  document.body.append(layer);
  return layer;
}

interface Line {
  l: number;
  t: number;
  r: number;
  b: number;
}

/** Text rects of the elements, merged into one rect per visual line, top to bottom. */
function lines(els: HTMLElement[]): Line[] {
  const rects = els
    .flatMap((e) => Array.from(e.getClientRects()))
    .filter((r) => r.width > 0.5 && r.height > 0.5)
    .sort((a, b) => a.top - b.top);
  const out: Line[] = [];
  for (const r of rects) {
    const last = out.at(-1);
    // Same line when the boxes overlap vertically by more than half the smaller one (inline math
    // is taller than the text around it).
    const overlap = last ? Math.min(last.b, r.bottom) - Math.max(last.t, r.top) : 0;
    if (last && overlap > Math.min(last.b - last.t, r.height) / 2) {
      last.l = Math.min(last.l, r.left);
      last.r = Math.max(last.r, r.right);
      last.t = Math.min(last.t, r.top);
      last.b = Math.max(last.b, r.bottom);
    } else out.push({ l: r.left, t: r.top, r: r.right, b: r.bottom });
  }
  return out;
}

/**
 * Outline of stacked line rects as one closed path, in page coordinates. Lines run from edge to
 * edge of the text column except where the marked text starts and ends, so the sides are straight
 * whatever the line lengths: a rectangle, or a rectangle with a notch at the first and last line.
 */
function outline(ls: Line[], column: DOMRect): string {
  const x = window.scrollX;
  const y = window.scrollY;
  const n = ls.length;
  const L = ls.map((s, i) => ({
    l: (i === 0 ? s.l : column.left) - PAD + x,
    r: (i === n - 1 ? s.r : column.right) + PAD + x,
    t: s.t - PAD + y,
    b: s.b + PAD + y,
  }));
  // A first line starting near the column edge, or a last line ending near it, is squared off.
  if (L[0].l - (column.left - PAD + x) < 24) L[0].l = column.left - PAD + x;
  if (column.right + PAD + x - L[n - 1].r < 24) L[n - 1].r = column.right + PAD + x;
  if (n === 1) return rect(L[0].l, L[0].t, L[0].r, L[0].b);
  // Neighbouring lines meet halfway across the line gap, so the outline has no waist.
  for (let i = 0; i + 1 < L.length; i++) {
    const mid = (L[i].b + L[i + 1].t) / 2;
    L[i].b = mid;
    L[i + 1].t = mid;
  }
  const pts: [number, number][] = [[L[0].l, L[0].t]];
  for (const s of L) pts.push([s.r, s.t], [s.r, s.b]);
  for (const s of [...L].reverse()) pts.push([s.l, s.b], [s.l, s.t]);
  // Drop repeated points of lines with the same edge.
  const kept = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
  return `M${kept.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("L")}Z`;
}

const rect = (l: number, t: number, r: number, b: number) =>
  `M${l.toFixed(1)},${t.toFixed(1)}H${r.toFixed(1)}V${b.toFixed(1)}H${l.toFixed(1)}Z`;

/** Content box of the paragraph's text in one language (padding excluded). */
function columnOf(box: Element): DOMRect {
  const r = box.getBoundingClientRect();
  const cs = getComputedStyle(box);
  const pl = parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
  const pr = parseFloat(cs.paddingRight) + parseFloat(cs.borderRightWidth);
  return new DOMRect(r.left + pl, r.top, r.width - pl - pr, r.height);
}

/**
 * Frame the marked sentence elements: one outline per paragraph and language. A sentence group
 * whose lines are not stacked (it wraps around a float) still gets one outline over its lines.
 */
export function drawPairFrame(els: HTMLElement[]) {
  clearPairFrame();
  if (!els.length) return;
  const groups = new Map<Element, HTMLElement[]>();
  for (const e of els) {
    const box = e.closest(".en, .zh") ?? e.parentElement;
    if (!box) continue;
    const list = groups.get(box) ?? [];
    list.push(e);
    groups.set(box, list);
  }
  const svg = ensureLayer();
  svg.setAttribute("width", String(document.documentElement.scrollWidth));
  svg.setAttribute("height", String(document.documentElement.scrollHeight));
  for (const [box, list] of groups) {
    // Hidden elements (the other language in a single-language mode) have no rects.
    const ls = lines(list);
    if (!ls.length) continue;
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", outline(ls, columnOf(box)));
    svg.append(path);
  }
}

export function clearPairFrame() {
  layer?.replaceChildren();
}
