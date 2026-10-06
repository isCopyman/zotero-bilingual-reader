// Sentence id -> its rendered spans (English and Chinese), rebuilt after each full render, so
// hover, translation updates and highlights never scan the whole document.

let index = new Map<string, HTMLElement[]>();

export function indexSpans(root: HTMLElement) {
  index = new Map();
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(".s[data-u]"))) {
    const id = el.dataset.u!;
    const list = index.get(id);
    if (list) list.push(el);
    else index.set(id, [el]);
  }
}

export function spansOf(id: string): HTMLElement[] {
  return index.get(id) ?? [];
}
