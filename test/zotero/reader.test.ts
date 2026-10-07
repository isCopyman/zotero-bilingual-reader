// Integration tests that run inside a throwaway Zotero profile (zotero-plugin test).
// They import a real PDF into the test library, seed the translation cache and a MinerU parse,
// open the bilingual tab, exercise the reader and save screenshots to test/out/.

declare const assert: any;
declare const describe: any;
declare const it: any;
declare const before: any;
declare const after: any;
declare const afterEach: any;

const Z = Zotero as any;
const PREFIX = "extensions.zotero.zbr.test";
const root = () => String(Z.Prefs.get(`${PREFIX}.root`, true));
const outDir = () => PathUtils.join(root(), "test", "out");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | null | undefined | false | Promise<T | null | undefined | false>, timeout = 60_000, step = 200): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) {
      const msg = `waitFor timed out after ${timeout} ms: ${fn}`;
      await IOUtils.writeUTF8(PathUtils.join(outDir(), "failures.txt"), msg + "\n", { mode: "appendOrCreate" }).catch(() => {});
      throw new Error(msg);
    }
    await sleep(step);
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await (Zotero.getMainWindow() as any).crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Screenshot the whole main window (including the reader iframe) to test/out/<name>.png. */
async function snap(name: string, win: any = Zotero.getMainWindow()) {
  await sleep(300);
  const bmp = await win.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
  const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext("2d").drawImage(bmp, 0, 0);
  const blob: Blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
  await IOUtils.makeDirectory(outDir(), { createAncestors: true, ignoreExisting: true });
  await IOUtils.write(PathUtils.join(outDir(), `${name}.png`), new Uint8Array(await blob.arrayBuffer()));
}

describe("Bilingual Reader in Zotero", function () {
  // The scaffold reporter prints "Expected: undefined" for thrown errors; keep the real message.
  const failures: string[] = [];
  let lastStep = "";
  afterEach(async function (this: any) {
    const t = this.currentTest;
    if (t?.state !== "failed") return;
    const e: any = t.err ?? {};
    const diff = e.actual !== undefined ? ` actual=${JSON.stringify(e.actual)} expected=${JSON.stringify(e.expected)}` : "";
    let dump = "";
    try {
      dump = JSON.stringify(e, Object.getOwnPropertyNames(e)).slice(0, 1500);
    } catch {
      dump = Object.keys(e).join(",");
    }
    const entry = `## ${t.fullTitle()} [last step: ${lastStep}]\n${e.message ?? ""}${diff}\n${String(e)}\n${dump}\n${e.stack ?? ""}\n`;
    failures.push(entry);
    await IOUtils.writeUTF8(PathUtils.join(outDir(), "failures.txt"), entry, { mode: "appendOrCreate" });
  });
  let attachment: any;
  let rdoc: Document;
  let rwin: any;

  before(async function () {
    const win = Zotero.getMainWindow() as any;
    win.resizeTo(1440, 960);
    const pdf = String(Z.Prefs.get(`${PREFIX}.pdf`, true));
    assert.isTrue(await IOUtils.exists(pdf), `test PDF missing: ${pdf}`);
    // No real (paid) agent is ever asked: until a test picks its own engine, translation goes to
    // one that refuses at once.
    Z.ZBR.api.registerEngine(
      { id: "test:idle", label: "Idle", kind: "mock", ready: true },
      () => ({ id: "test:idle", label: "Idle", complete: async () => { throw new Error("test engine: no translation"); } }),
      1,
    );
    Z.Prefs.set("extensions.zotero.zbr.readerPrefs", JSON.stringify({ engineId: "test:idle", fontSize: 17, theme: "auto" }), true);
    // Most tests drive the page in a tab of its own; the overlay view has its own test.
    Z.Prefs.set("extensions.zotero.zbr.openMode", "tab", true);
    attachment = await Z.Attachments.importFromFile({ file: pdf, libraryID: Z.Libraries.userLibraryID });
    const key = attachment.key;

    // Seed the translation cache with the fixture translations (hash -> zh).
    const fixtureTr = (await IOUtils.readJSON(PathUtils.join(root(), "dev", "fixtures", "translations.json"))) as Record<string, string>;
    const units: Record<string, any> = {};
    for (const [hash, zh] of Object.entries(fixtureTr)) units[hash] = { zh, engine: "fixture", prompt: "p1", glossary: "", t: Date.now() };
    const dir = Z.ZBR.api.cacheDir();
    await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
    await IOUtils.writeJSON(PathUtils.join(dir, `${attachment.libraryID}-${key}.json`), { version: 1, libraryID: attachment.libraryID, attachmentKey: key, units });

    // Seed a MinerU parse for this attachment key in the test data directory.
    const mdir = PathUtils.join(Z.DataDirectory.dir, "mineru-paper-store", "attachments", key);
    await IOUtils.makeDirectory(PathUtils.join(mdir, "raw"), { createAncestors: true, ignoreExisting: true });
    await IOUtils.copy(PathUtils.join(root(), "test", "fixtures", "zhang2021.mineru.json"), PathUtils.join(mdir, "raw", "content_list.json"));
    await IOUtils.writeJSON(PathUtils.join(mdir, "parse.json"), { status: "complete", pdfSha256: await sha256Hex(await IOUtils.read(pdf)) });
  });

  after(function () {
    // Close bilingual tabs so Zotero can quit cleanly when the run ends.
    const Tabs = (Zotero.getMainWindow() as any).Zotero_Tabs;
    const ids = Tabs._tabs.filter((t: any) => t.type === "zbr").map((t: any) => t.id);
    if (ids.length) Tabs.close(ids);
  });

  it("gets structured document text from Zotero (diagnostic)", async function () {
    const t0 = Date.now();
    const progress: number[] = [];
    const diag: any = { hasSDT: !!Z.SDT, pdfWorker: !!Z.PDFWorker };
    const r = await Promise.race([
      Z.SDT.getPack(attachment.id, { isPriority: true, onProgress: (p: number) => progress.push(p) }),
      sleep(150_000).then(() => ({ ok: false, reason: "timeout-150s" })),
    ]);
    Object.assign(diag, { ms: Date.now() - t0, ok: r.ok, reason: r.reason, bytes: r.bytes?.byteLength, progress: progress.slice(-5) });
    await IOUtils.makeDirectory(outDir(), { createAncestors: true, ignoreExisting: true });
    await IOUtils.writeJSON(PathUtils.join(outDir(), "diag.json"), diag);
    assert.isTrue(r.ok, `SDT unavailable: ${JSON.stringify(diag)}`);
  });

  it("dumps the structured text of another paper (diagnostic, ZBR_DUMP_PDF)", async function () {
    const pdf = String(Z.Prefs.get(`${PREFIX}.dumpPdf`, true) || "");
    if (!pdf) return this.skip();
    this.timeout(300_000);
    const att = await Z.Attachments.importFromFile({ file: pdf, libraryID: Z.Libraries.userLibraryID });
    const reader = await Z.SDT.getReader(att.id, { isPriority: true });
    const sdt = await reader.materialize();
    await IOUtils.makeDirectory(outDir(), { createAncestors: true, ignoreExisting: true });
    await IOUtils.writeJSON(PathUtils.join(outDir(), "dump-sdt.json"), sdt);
    await att.eraseTx();
  });

  it("opens a bilingual tab and renders the paper", async function () {
    await Z.ZBR.api.openBilingual(attachment);
    const win = Zotero.getMainWindow() as any;
    const tab = win.Zotero_Tabs._tabs.find((t: any) => t.type === "zbr");
    assert.ok(tab, "bilingual tab exists");
    const iframe = await waitFor(() => win.document.getElementById(tab.id)?.querySelector("iframe") as HTMLIFrameElement);
    rwin = iframe.contentWindow;
    await sleep(4_000);
    const page = rwin.wrappedJSObject ?? rwin;
    const diag = {
      url: rwin.location?.href,
      readyState: rwin.document?.readyState,
      bodyClass: rwin.document?.body?.className,
      body: rwin.document?.body?.innerHTML?.slice(0, 600),
      hostViaXray: typeof rwin.zbrHost,
      hostOnPage: typeof page.zbrHost,
      errors: (Z.getErrors?.(true) ?? []).slice(-15).map((e: any) => String(e).slice(0, 400)),
    };
    await IOUtils.writeJSON(PathUtils.join(outDir(), "diag-open.json"), diag);
    rdoc = await waitFor(() => (rwin.document.body?.classList.contains("ready") ? rwin.document : null), 120_000);
    const blocks = rdoc.querySelectorAll("section.blk").length;
    assert.isAbove(blocks, 150, "paragraph blocks rendered");
    const progress = rdoc.getElementById("progress")!.textContent!;
    assert.match(progress, /已译 4\d\d\/4\d\d/, `cached translations loaded: ${progress}`);
    await snap("01-interleave");
  });

  // First scroll through the side-by-side view, frame by frame (test/out/scroll-frames*.json):
  // how long each refresh takes, and what ran meanwhile (PDF page renders, KaTeX).
  async function scrollDiagnostic(doc: Document, win: any, file: string) {
    const wu0 = win.windowUtils;
    wu0.advanceTimeAndRefresh(0);
    let switchMs = 0;
    try {
      const t = win.performance.now();
      (doc.querySelector('[data-mode="side"]') as HTMLElement).click();
      wu0.advanceTimeAndRefresh(16);
      switchMs = Math.round(win.performance.now() - t);
    } finally {
      wu0.restoreNormalRefresh();
    }
    await waitFor(() => doc.getElementById("doc")!.className === "mode-side", 5000, 20);
    const se = doc.scrollingElement!;
    se.scrollTop = 0;
    await sleep(1500);
    // Real frames (when the window is visible): smooth wheel-like scrolling from the top again in
    // a fresh mode switch, recording gaps between animation frames, paint included.
    const gaps: number[] = [];
    await new Promise<void>((resolve) => {
      let last = 0;
      const end = win.performance.now() + 8000;
      const tick = (t: number) => {
        if (last) gaps.push(Math.round(t - last));
        last = t;
        se.scrollTop += 40;
        if (t < end && se.scrollTop < se.scrollHeight - win.innerHeight - 50) win.requestAnimationFrame(tick);
        else resolve();
      };
      win.requestAnimationFrame(tick);
      setTimeout(resolve, 12_000);
    });
    const realFrames = { frames: gaps.length, over33: gaps.filter((g) => g > 33).length, over100: gaps.filter((g) => g > 100).length, worst: [...gaps].sort((a, b) => b - a).slice(0, 10), median: [...gaps].sort((a, b) => a - b)[gaps.length >> 1] };
    se.scrollTop = 0;
    await sleep(800);
    win.performance.clearMeasures();
    // Drive the refresh driver by hand: each tick runs style, layout (including content that
    // content-visibility just un-skipped) and paint synchronously, so it can be timed even when
    // the test window is covered and real frames are throttled.
    const wu = win.windowUtils;
    const steps: any[] = [];
    const jumps: any[] = [];
    wu.advanceTimeAndRefresh(0);
    const t00 = win.performance.now();
    try {
      for (let y = 120; y < se.scrollHeight - 900; y += 120) {
        se.scrollTop = y;
        const t0 = win.performance.now();
        // The mouse rests over the page while the wheel scrolls it: new content passes under it.
        doc.elementFromPoint(win.innerWidth / 2, win.innerHeight / 2)?.dispatchEvent(new win.MouseEvent("mouseover", { bubbles: true }));
        wu.advanceTimeAndRefresh(16);
        steps.push({ y, ms: Math.round(win.performance.now() - t0) });
        // Scroll anchoring moving the page under the reader (sizes estimated before first layout).
        if (Math.abs(se.scrollTop - y) > 2) jumps.push({ y, now: se.scrollTop });
        await sleep(0);
      }
    } finally {
      wu.restoreNormalRefresh();
    }
    const wall = Math.round(win.performance.now() - t00);
    const measures = (name: string) => win.performance.getEntriesByName(name).map((m: any) => Math.round(m.duration));
    const out = {
      switchToSideFrameMs: switchMs,
      realFrames,
      steps: steps.length,
      wallMs: wall,
      avgFrameMs: Math.round(steps.reduce((n, s) => n + s.ms, 0) / steps.length),
      slowFrames: steps.filter((s) => s.ms > 50).length,
      worst: [...steps].sort((a, b) => b.ms - a.ms).slice(0, 12),
      jumps: jumps.length,
      firstJumps: jumps.slice(0, 5),
      pdfPageRenders: measures("zbr-pdf-page"),
      katex: { count: measures("zbr-katex").length, totalMs: measures("zbr-katex").reduce((a: number, b: number) => a + b, 0) },
      nodes: doc.getElementsByTagName("*").length,
    };
    await IOUtils.writeJSON(PathUtils.join(outDir(), file), out);
    (doc.querySelector('[data-mode="interleave"]') as HTMLElement).click();
    se.scrollTop = 0;
    return out;
  }

  it("scrolls the side-by-side view smoothly the first time (diagnostic)", async function () {
    this.timeout(180_000);
    await scrollDiagnostic(rdoc, rwin, "scroll-frames.json");
  });

  it("scrolls another paper smoothly the first time (diagnostic, ZBR_PERF_PDF)", async function () {
    const pdf = String(Z.Prefs.get(`${PREFIX}.perfPdf`, true) || "");
    if (!pdf) return this.skip();
    this.timeout(300_000);
    const att = await Z.Attachments.importFromFile({ file: pdf, libraryID: Z.Libraries.userLibraryID });
    const cache = String(Z.Prefs.get(`${PREFIX}.perfCache`, true) || "");
    if (cache) {
      const data: any = await IOUtils.readJSON(cache);
      Object.assign(data, { libraryID: att.libraryID, attachmentKey: att.key, position: undefined });
      await IOUtils.writeJSON(PathUtils.join(Z.ZBR.api.cacheDir(), `${att.libraryID}-${att.key}.json`), data);
    }
    const mineru = String(Z.Prefs.get(`${PREFIX}.perfMineru`, true) || "");
    if (mineru) {
      const mdir = PathUtils.join(Z.DataDirectory.dir, "mineru-paper-store", "attachments", att.key);
      await IOUtils.makeDirectory(PathUtils.join(mdir, "raw"), { createAncestors: true, ignoreExisting: true });
      await IOUtils.copy(PathUtils.join(mineru, "raw", "content_list.json"), PathUtils.join(mdir, "raw", "content_list.json"));
      await IOUtils.writeJSON(PathUtils.join(mdir, "parse.json"), { status: "complete", pdfSha256: await sha256Hex(await IOUtils.read(pdf)) });
    }
    await Z.ZBR.api.openBilingual(att);
    const win = Zotero.getMainWindow() as any;
    const tab = win.Zotero_Tabs._tabs.filter((t: any) => t.type === "zbr").at(-1);
    const iframe = await waitFor(() => win.document.getElementById(tab.id)?.querySelector("iframe") as HTMLIFrameElement);
    const pwin = iframe.contentWindow as any;
    const pdoc = await waitFor(() => (pwin.document.body?.classList.contains("ready") ? pwin.document : null), 180_000);
    await scrollDiagnostic(pdoc, pwin, "scroll-frames-perf.json");
    win.Zotero_Tabs.close(tab.id);
    win.Zotero_Tabs.select(win.Zotero_Tabs._tabs.find((t: any) => t.type === "zbr").id);
  });

  // Screenshots for the README (test/out/promo-*.png), taken while the page still shows only
  // the fixture's real translations (later tests write "【测试】" ones).
  it("takes the README screenshots", async function () {
    this.timeout(120_000);
    const engine = rdoc.getElementById("engine") as HTMLSelectElement;
    const label = engine.selectedOptions[0].textContent;
    engine.selectedOptions[0].textContent = "Claude Code";
    const mode = async (m: string) => {
      (rdoc.querySelector(`[data-mode="${m}"]`) as HTMLElement).click();
      await waitFor(() => rdoc.getElementById("doc")!.className === `mode-${m}`, 5000, 20);
    };
    const show = async (el: Element, block: ScrollLogicalPosition = "start") => {
      el.scrollIntoView({ block });
      await sleep(900);
    };
    const nth = (sel: string, i = 0) => [...rdoc.querySelectorAll<HTMLElement>(sel)][i];
    const hover = (el: Element) => el.dispatchEvent(new rwin.MouseEvent("mouseover", { bubbles: true }));
    const unhover = (el: Element) => el.dispatchEvent(new rwin.MouseEvent("mouseout", { bubbles: true, relatedTarget: rdoc.body }));

    await mode("interleave");
    rdoc.scrollingElement!.scrollTop = 0;
    await sleep(900);
    lastStep = "promo before promo-01-interleave";
    await snap("promo-01-interleave");
    // Mode switches re-render the page: look sections up again by id each time.
    const introId = nth("section.k-paragraph.done", 6).dataset.b!;
    const sec = (id: string) => rdoc.querySelector<HTMLElement>(`section.blk[data-b="${id}"]`)!;
    await mode("side");
    await show(sec(introId));
    lastStep = "promo before promo-02-side";
    await snap("promo-02-side");
    await mode("zh");
    await show(sec(introId));
    lastStep = "promo before promo-03-zh";
    await snap("promo-03-zh");
    await mode("en");
    await show(sec(introId), "center");
    const s = sec(introId).querySelectorAll<HTMLElement>(".s[data-u]")[1];
    hover(s);
    await waitFor(() => rdoc.querySelector(".peek"), 3000);
    lastStep = "promo before promo-04-peek";
    await snap("promo-04-peek");
    unhover(s);
    await mode("interleave");
    const paraId = nth("section.k-paragraph.done", 8).dataset.b!;
    await show(sec(paraId), "center");
    const en = sec(paraId).querySelectorAll<HTMLElement>(".en .s[data-u]")[1];
    hover(en);
    await sleep(300);
    lastStep = "promo before promo-05-pair";
    await snap("promo-05-pair");
    unhover(en);
    const mathSec = [...rdoc.querySelectorAll<HTMLElement>("section.k-math:not(.covered)")][1];
    await show(mathSec, "center");
    await waitFor(() => mathSec.querySelector("figure .katex, figure img"), 20_000);
    await sleep(500);
    await waitFor(() => !rdoc.querySelector("figure.fig.loading"), 10_000).catch(() => {});
    lastStep = "promo before promo-06-math";
    await snap("promo-06-math");
    const table = rdoc.querySelector("section.k-table");
    if (table) {
      await show(table, "start");
      await waitFor(() => table.querySelector("table, img"), 20_000).catch(() => {});
      await sleep(600);
      await snap("promo-07-table");
    }
    const theme = rdoc.getElementById("opt-theme") as HTMLSelectElement;
    theme.value = "dark";
    theme.dispatchEvent(new rwin.Event("change", { bubbles: true }));
    await show(sec(introId));
    lastStep = "promo before promo-08-dark";
    await snap("promo-08-dark");
    theme.value = "auto";
    theme.dispatchEvent(new rwin.Event("change", { bubbles: true }));
    await show(sec(paraId), "center");
    hover(sec(paraId).querySelector(".en .s")!);
    await waitFor(() => !(rdoc.getElementById("blk-action") as HTMLElement).hidden, 3000);
    lastStep = "promo before promo-09-paragraph-button";
    await snap("promo-09-paragraph-button");
    engine.selectedOptions[0].textContent = label;
  });

  it("keeps the tab list intact for other plugins and leaves the bilingual tab out of the saved session", async function () {
    const win = Zotero.getMainWindow() as any;
    // In a tab of its own there is no PDF underneath to go back to.
    assert.equal(rwin.getComputedStyle(rdoc.getElementById("btn-back-pdf")!).display, "none");
    const Tabs = win.Zotero_Tabs;
    const state = Tabs.getState();
    // Tab plugins pair getState() with _tabs by index: same length, same order.
    assert.equal(state.length, Tabs._tabs.length);
    const i = Tabs._tabs.findIndex((t: any) => t.type === "zbr");
    assert.isAtLeast(i, 0);
    assert.equal(state[i].type, "zbr");
    assert.deepInclude(Tabs._tabs[i].data.companionOf, { itemID: attachment.id });
    // The session (what Zotero restores on start) has no bilingual tab.
    assert.isFalse(win.ZoteroPane.getState().tabs.some((t: any) => t.type === "zbr"));
  });

  it("switches display modes", async function () {
    for (const mode of ["side", "zh", "en"]) {
      (rdoc.querySelector(`[data-mode="${mode}"]`) as HTMLElement).click();
      await sleep(400);
      assert.equal(rdoc.getElementById("doc")!.className, `mode-${mode}`);
      await snap(`02-mode-${mode}`);
    }
  });

  it("switches modes with the 1-4 keys", async function () {
    for (const [key, mode] of [["3", "side"], ["4", "zh"], ["2", "interleave"]]) {
      rdoc.body.dispatchEvent(new rwin.KeyboardEvent("keydown", { key, bubbles: true }));
      await waitFor(() => rdoc.getElementById("doc")!.className === `mode-${mode}`, 5000, 20);
    }
  });

  it("remembers the reading position when the paper is reopened", async function () {
    const target = [...rdoc.querySelectorAll<HTMLElement>("section.k-heading")][6];
    target.scrollIntoView({ block: "start" });
    rwin.dispatchEvent(new rwin.Event("scroll"));
    await sleep(900);
    const win = Zotero.getMainWindow() as any;
    win.Zotero_Tabs.close(win.Zotero_Tabs._tabs.find((t: any) => t.type === "zbr").id);
    // With the PDF open in Zotero's reader and another tab after it, the bilingual tab opens next to the PDF.
    await Z.Reader.open(attachment.id);
    const pdfTab = await waitFor(() => win.Zotero_Tabs.getTabIDByItemID(attachment.id), 30_000);
    const other = await Z.Attachments.importFromFile({ file: String(Z.Prefs.get(`${PREFIX}.pdf`, true)), libraryID: Z.Libraries.userLibraryID });
    await Z.Reader.open(other.id);
    const otherTab = await waitFor(() => win.Zotero_Tabs.getTabIDByItemID(other.id), 30_000);
    win.Zotero_Tabs.select(pdfTab);
    await Z.ZBR.api.openBilingual(attachment);
    const order = win.Zotero_Tabs._tabs.map((t: any) => `${t.type}:${t.id}`);
    const tab = win.Zotero_Tabs._tabs.find((t: any) => t.type === "zbr");
    const placed = order.indexOf(`zbr:${tab.id}`) === order.findIndex((x: string) => x.endsWith(`:${pdfTab}`)) + 1;
    lastStep = `tabs ${order.join(" ")} pdf=${pdfTab}`;
    win.Zotero_Tabs.close([otherTab, pdfTab]);
    win.Zotero_Tabs.select(tab.id);
    await other.eraseTx();
    const iframe = await waitFor(() => win.document.getElementById(tab.id)?.querySelector("iframe") as HTMLIFrameElement);
    rwin = iframe.contentWindow;
    rdoc = await waitFor(() => (rwin.document?.body?.classList.contains("ready") ? rwin.document : null), 120_000);
    await sleep(500);
    const top = rdoc.querySelector<HTMLElement>(`section.blk[data-b="${target.dataset.b}"]`)!.getBoundingClientRect().top;
    assert.isBelow(Math.abs(top), 150, `restored heading at ${top}px`);
    assert.isTrue(placed, "bilingual tab sits right after the PDF tab");
  });

  it("shows the Chinese bubble when hovering English", async function () {
    (rdoc.querySelector('[data-mode="en"]') as HTMLElement).click();
    await waitFor(() => rdoc.getElementById("doc")!.className === "mode-en", 5000, 20);
    const span = [...rdoc.querySelectorAll<HTMLElement>("section.k-paragraph .s[data-u]")][12];
    span.scrollIntoView({ block: "center" });
    await sleep(300);
    span.dispatchEvent(new rwin.MouseEvent("mouseover", { bubbles: true }));
    const peek = await waitFor(() => rdoc.querySelector(".peek"), 3000);
    assert.match(peek.textContent!, /[一-鿿]/);
    await snap("03-peek-en");
    // Themes recolour the bubble with the page; the font-size buttons resize it too.
    const theme = rdoc.getElementById("opt-theme") as HTMLSelectElement;
    const bg = () => rwin.getComputedStyle(rdoc.querySelector(".peek")!).backgroundColor;
    const pick = async (v: string) => {
      theme.value = v;
      theme.dispatchEvent(new rwin.Event("change", { bubbles: true }));
      await waitFor(() => rdoc.documentElement.dataset.theme === v, 3000, 20);
    };
    await pick("light");
    assert.equal(bg(), "rgb(255, 255, 255)");
    await pick("sepia");
    assert.equal(bg(), "rgb(251, 245, 230)");
    await snap("03b-peek-sepia");
    await pick("dark");
    assert.equal(bg(), "rgb(17, 24, 39)");
    await snap("03c-peek-dark");
    // A+ re-renders the page (the bubble goes with it); hovering again shows the larger bubble.
    const hover = async () => {
      const s = rdoc.querySelector<HTMLElement>(`.s[data-u="${span.dataset.u}"]`)!;
      s.dispatchEvent(new rwin.MouseEvent("mouseover", { bubbles: true }));
      const p = await waitFor(() => rdoc.querySelector(".peek"), 3000);
      return { s, size: parseFloat(rwin.getComputedStyle(p).fontSize) };
    };
    const before = (await hover()).size;
    (rdoc.getElementById("font-inc") as HTMLElement).click();
    await sleep(300);
    const after = await hover();
    assert.isAbove(after.size, before, "bubble follows the font size");
    after.s.dispatchEvent(new rwin.MouseEvent("mouseout", { bubbles: true, relatedTarget: rdoc.body }));
    (rdoc.getElementById("font-dec") as HTMLElement).click();
    theme.value = "auto";
    theme.dispatchEvent(new rwin.Event("change", { bubbles: true }));
  });

  it("marks the sentence pair with the chosen style and colour", async function () {
    (rdoc.querySelector('[data-mode="interleave"]') as HTMLElement).click();
    await waitFor(() => rdoc.getElementById("doc")!.className === "mode-interleave", 5000, 20);
    const span = [...rdoc.querySelectorAll<HTMLElement>("section.k-paragraph.done .en .s[data-u]")][3];
    span.scrollIntoView({ block: "center" });
    await sleep(300);
    span.dispatchEvent(new rwin.MouseEvent("mouseover", { bubbles: true }));
    const zh = await waitFor(() => rdoc.querySelector<HTMLElement>(`.zh .s.hl[data-u="${span.dataset.u}"]`), 3000);
    const css = () => rwin.getComputedStyle(zh);
    // One outline per language around the marked text, not a box per sentence or line.
    const frames = () => [...rdoc.querySelectorAll<SVGPathElement>("#pair-frame path")];
    assert.equal(frames().length, 2, "one frame for English, one for Chinese");
    assert.equal(rwin.getComputedStyle(frames()[0]).stroke, "rgb(37, 99, 235)", "blue frame by default");
    assert.equal(css().boxShadow, "none");
    // Three sentences: still one frame per language.
    (rdoc.querySelector('[data-gran="3"]') as HTMLElement).click();
    span.dispatchEvent(new rwin.MouseEvent("mouseout", { bubbles: true, relatedTarget: rdoc.body }));
    const para = [...rdoc.querySelectorAll<HTMLElement>("section.k-paragraph.done")].find((p) => p.querySelectorAll(".en .s[data-u]").length >= 6)!;
    para.scrollIntoView({ block: "center" });
    const other = para.querySelector<HTMLElement>(".en .s[data-u]")!;
    other.dispatchEvent(new rwin.MouseEvent("mouseover", { bubbles: true }));
    await waitFor(() => rdoc.querySelectorAll(".en .s.hl").length >= 2, 3000, 20);
    assert.equal(frames().length, 2, "group of sentences: one frame per language");
    await snap("03c-pair-frame");
    (rdoc.querySelector('[data-gran="1"]') as HTMLElement).click();
    span.dispatchEvent(new rwin.MouseEvent("mouseover", { bubbles: true }));
    await waitFor(() => rdoc.querySelector(`.zh .s.hl[data-u="${span.dataset.u}"]`), 3000);
    const style = rdoc.getElementById("opt-pair") as HTMLSelectElement;
    const color = rdoc.getElementById("opt-pair-color") as HTMLInputElement;
    style.value = "underline";
    style.dispatchEvent(new rwin.Event("change", { bubbles: true }));
    color.value = "#dc2626";
    color.dispatchEvent(new rwin.Event("input", { bubbles: true }));
    await waitFor(() => css().textDecorationLine === "underline", 3000, 20);
    assert.equal(css().textDecorationColor, "rgb(220, 38, 38)");
    assert.isTrue(frames().every((f) => rwin.getComputedStyle(f.ownerSVGElement!).display === "none"), "no frame with underline");
    await snap("03d-pair-underline");
    style.value = "fill";
    style.dispatchEvent(new rwin.Event("change", { bubbles: true }));
    await waitFor(() => css().backgroundColor !== "rgba(0, 0, 0, 0)", 3000, 20);
    assert.equal(JSON.parse(String(Z.Prefs.get("extensions.zotero.zbr.readerPrefs", true))).pairStyle, "fill", "remembered");
    (rdoc.getElementById("opt-pair-reset") as HTMLElement).click();
    style.value = "frame";
    style.dispatchEvent(new rwin.Event("change", { bubbles: true }));
    span.dispatchEvent(new rwin.MouseEvent("mouseover", { bubbles: true, relatedTarget: rdoc.body }));
    await waitFor(() => frames().length === 2 && rwin.getComputedStyle(frames()[0]).stroke === "rgb(37, 99, 235)", 3000, 20);
    span.dispatchEvent(new rwin.MouseEvent("mouseout", { bubbles: true, relatedTarget: rdoc.body }));
  });

  it("finds English and Chinese text with Ctrl+F", async function () {
    (rdoc.querySelector('[data-mode="side"]') as HTMLElement).click();
    await waitFor(() => rdoc.getElementById("doc")!.className === "mode-side", 5000, 20);
    rdoc.scrollingElement!.scrollTop = 0;
    rdoc.body.dispatchEvent(new rwin.KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
    const bar = rdoc.getElementById("find-bar")!;
    lastStep = `find: open bar=${!!rdoc.getElementById("find-bar")} blk=${!!rdoc.getElementById("blk-action")} body=${rdoc.body.children.length} ${[...rdoc.body.children].map((c: any) => c.id || c.tagName).join(",")}`;
    await waitFor(() => !bar.hidden, 2000, 20);
    const input = rdoc.getElementById("find-input") as HTMLInputElement;
    assert.equal(rdoc.activeElement, input, "focus goes to the search box");
    const type = async (q: string) => {
      const before = rdoc.getElementById("find-count")!.textContent;
      rdoc.getElementById("find-count")!.textContent = "";
      input.value = q;
      input.dispatchEvent(new rwin.Event("input", { bubbles: true }));
      void before;
      return waitFor(() => /\d+\/\d+|无结果/.test(rdoc.getElementById("find-count")!.textContent!) && rdoc.getElementById("find-count")!.textContent, 3000, 20);
    };
    lastStep = "find: en";
    const en = await type("ensemble NWP");
    lastStep = `find: en=${en}`;
    assert.match(en, /^1\/\d+$/);
    const cur = rdoc.querySelector<HTMLElement>(".s.found-cur")!;
    assert.match(cur.textContent!, /ensemble NWP/i);
    const r = cur.getBoundingClientRect();
    assert.isTrue(r.top > 0 && r.bottom < rwin.innerHeight, "scrolled to the hit");
    lastStep = "find: zh";
    const zh = await type("风电");
    lastStep = `find: zh=${zh}`;
    const n = Number(zh.split("/")[1]);
    assert.isAbove(n, 5);
    assert.isNotNull(rdoc.querySelector(".zh .s.found-cur"), "Chinese hit shown in the Chinese column");
    input.dispatchEvent(new rwin.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await waitFor(() => rdoc.getElementById("find-count")!.textContent === `2/${n}`, 2000, 20);
    await snap("16-find");
    input.dispatchEvent(new rwin.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await waitFor(() => bar.hidden && !rdoc.querySelector(".s.found"), 2000, 20);
    (rdoc.querySelector('[data-mode="interleave"]') as HTMLElement).click();
  });

  it("stays responsive: mode switch, hover and scrolling (timings in test/out/perf.json)", async function () {
    const perf: Record<string, number> = {};
    const doc = rdoc.getElementById("doc")!;
    // Scrolling the whole paper must not start real (paid) translation of the few untranslated units.
    const auto = rdoc.getElementById("opt-auto") as HTMLInputElement;
    if (auto.checked) auto.click();
    // Timings come from performance entries and synchronous layout, not animation frames: a
    // covered or minimised test window throttles frames and timers by seconds.
    for (const mode of ["side", "interleave"]) {
      rwin.performance.clearMeasures("zbr-render");
      (rdoc.querySelector(`[data-mode="${mode}"]`) as HTMLElement).click();
      const [m] = await waitFor(() => rwin.performance.getEntriesByName("zbr-render").length && rwin.performance.getEntriesByName("zbr-render"), 30_000, 20);
      perf[`render-${mode}-ms`] = Math.round(m.duration);
    }
    const spans = [...rdoc.querySelectorAll<HTMLElement>(".en .s[data-u]")].slice(0, 400);
    let t0 = rwin.performance.now();
    for (const s of spans) s.dispatchEvent(new rwin.MouseEvent("mouseover", { bubbles: true }));
    perf["hover-handler-avg-ms"] = +((rwin.performance.now() - t0) / spans.length).toFixed(3);
    spans.at(-1)!.dispatchEvent(new rwin.MouseEvent("mouseout", { bubbles: true, relatedTarget: rdoc.body }));
    // Scroll through the whole paper; each step forces style and layout of the newly visible part.
    const se = rdoc.scrollingElement!;
    let worst = 0;
    t0 = rwin.performance.now();
    for (let y = 0; y < se.scrollHeight; y += 700) {
      const f0 = rwin.performance.now();
      se.scrollTop = y;
      rdoc.elementFromPoint(400, 400);
      worst = Math.max(worst, rwin.performance.now() - f0);
    }
    perf["scroll-layout-total-ms"] = Math.round(rwin.performance.now() - t0);
    perf["scroll-layout-worst-step-ms"] = Math.round(worst);
    perf["dom-nodes"] = rdoc.getElementsByTagName("*").length;
    se.scrollTop = 0;
    await IOUtils.writeJSON(PathUtils.join(outDir(), "perf.json"), perf);
    assert.isBelow(perf["hover-handler-avg-ms"], 4, JSON.stringify(perf));
    assert.isBelow(perf["render-side-ms"], 300, JSON.stringify(perf));
    assert.isBelow(perf["scroll-layout-worst-step-ms"], 50, JSON.stringify(perf));
  });

  it("side panel: outline with the current section, bookmarks, and the paper's annotations", async function () {
    lastStep = "outline 1";
    const host = rwin.wrappedJSObject.zbrHost;
    const key = (k: string) => rdoc.body.dispatchEvent(new rwin.KeyboardEvent("keydown", { key: k, bubbles: true }));
    rdoc.scrollingElement!.scrollTop = 0;
    lastStep = "outline 2";
    key("t");
    lastStep = "outline 3";
    const panel = await waitFor(() => { const p = rdoc.getElementById("outline"); return p && !p.hidden && p; }, 3000, 20);
    lastStep = "outline 4";
    assert.isTrue(rdoc.body.classList.contains("outline-open"));
    lastStep = "outline 5";
    const items = [...panel.querySelectorAll<HTMLElement>(".ol-toc .ol-item")];
    lastStep = "outline 6";
    assert.isAbove(items.length, 10, "headings listed");
    // Jump to a later heading; it becomes the current one.
    lastStep = "outline 7";
    const target = items[Math.floor(items.length / 2)];
    lastStep = "outline 8";
    target.querySelector<HTMLElement>(".ol-text")!.click();
    lastStep = "outline 9";
    const tid = target.dataset.b!;
    await waitFor(() => rdoc.querySelector(`#outline .ol-item.cur[data-b="${tid}"]`), 3000, 20).catch((e) => {
      lastStep += ` cur=${rdoc.querySelector("#outline .ol-item.cur")?.getAttribute("data-b")} want=${tid} top=${rdoc.querySelector(`section.blk[data-b="${tid}"]`)?.getBoundingClientRect().top} scroll=${rdoc.scrollingElement!.scrollTop}`;
      throw e;
    });
    lastStep = "outline 10";
    const sec = rdoc.querySelector<HTMLElement>(`section.blk[data-b="${target.dataset.b}"]`)!;
    lastStep = "outline 11";
    assert.isTrue(sec.getBoundingClientRect().top < 200, "scrolled to the heading");
    lastStep = "outline 12";
    await snap("18-outline");
    // Bookmark the place with B; it is kept with the paper.
    lastStep = "outline 13";
    const marksBefore = (await host.getBookmarks()).length;
    lastStep = "outline 14";
    key("b");
    lastStep = "outline 15";
    await waitFor(async () => (await host.getBookmarks()).length === marksBefore + 1, 3000, 50);
    lastStep = "outline 16";
    panel.querySelectorAll<HTMLElement>(".ol-tabs button")[1].click();
    lastStep = "outline 17";
    await waitFor(() => panel.querySelectorAll(".ol-marks .ol-mark").length === marksBefore + 1, 3000, 20);
    lastStep = "outline 18";
    assert.isNotNull(rdoc.querySelector("section.blk.bookmarked"));
    lastStep = "outline 19";
    await snap("18b-bookmarks");
    // Annotations: a highlight made here is listed, with its comment.
    lastStep = "outline 20";
    const unit = [...rdoc.querySelectorAll<HTMLElement>("section.k-paragraph .en .s[data-u]")][30].dataset.u!;
    lastStep = "outline 21";
    await host.createHighlight({ unitIds: [unit], color: "#5fb236", comment: "回头看这里" });
    lastStep = "outline 22";
    panel.querySelectorAll<HTMLElement>(".ol-tabs button")[2].click();
    lastStep = "outline 23";
    const commentOf = (n: Element) => n.querySelector<HTMLTextAreaElement>("textarea.ol-note-comment")?.value ?? "";
    const note = await waitFor(() => [...panel.querySelectorAll<HTMLElement>(".ol-notes .ol-note")].find((n) => /回头看这里/.test(commentOf(n))), 5000, 20);
    note.click();
    lastStep = "outline 24";
    await waitFor(() => { const s = rdoc.querySelector<HTMLElement>(`.s[data-u="${unit}"]`)!.getBoundingClientRect(); return s.top > 0 && s.bottom < rwin.innerHeight; }, 3000, 20);
    lastStep = "outline 25";
    await snap("18c-annotations");
    // The comment is edited in place and saved by itself shortly after typing stops; the card
    // keeps focus while Zotero's copy is updated (test/out/comment-edit.json: times).
    lastStep = "outline 25b";
    const ta = note.querySelector<HTMLTextAreaElement>("textarea.ol-note-comment")!;
    ta.focus();
    const typeTimes: number[] = [];
    for (const ch of "，第二遍") {
      const t = rwin.performance.now();
      ta.value += ch;
      ta.dispatchEvent(new rwin.Event("input", { bubbles: true }));
      typeTimes.push(Math.round((rwin.performance.now() - t) * 10) / 10);
      await sleep(80);
    }
    const t0 = Date.now();
    const saved = await waitFor(() => attachment.getAnnotations().find((a: any) => a.annotationComment === "回头看这里，第二遍"), 5000, 20);
    const saveMs = Date.now() - t0;
    await sleep(800);
    assert.equal(rdoc.activeElement, ta, "still typing in the same field after the save");
    await IOUtils.writeJSON(PathUtils.join(outDir(), "comment-edit.json"), { typeTimes, saveMsAfterLastKey: saveMs });
    ta.blur();
    saved.annotationComment = "回头看这里";
    await saved.saveTx();
    // Clean up: highlight, bookmark, panel.
    lastStep = "outline 26";
    for (const a of attachment.getAnnotations()) if (a.annotationComment === "回头看这里") await a.eraseTx();
    lastStep = "outline 27";
    await host.setBookmarks((await host.getBookmarks()).slice(0, marksBefore));
    lastStep = "outline 28";
    panel.querySelectorAll<HTMLElement>(".ol-tabs button")[0].click();
    lastStep = "outline 29";
    key("t");
    lastStep = "outline 30";
    await waitFor(() => panel.hidden && !rdoc.body.classList.contains("outline-open"), 3000, 20);
  });

  it("opens as a view inside the PDF's own tab, switched with buttons", async function () {
    const win = Zotero.getMainWindow() as any;
    const Tabs = win.Zotero_Tabs;
    const tabsBefore = Tabs._tabs.length;
    const zbrTab = Tabs._tabs.find((t: any) => t.type === "zbr");
    if (zbrTab) Tabs.close(zbrTab.id);
    Z.Prefs.set("extensions.zotero.zbr.openMode", "overlay", true);
    try {
      await Z.ZBR.api.openBilingual(attachment);
      const tabID = Tabs.getTabIDByItemID(attachment.id);
      assert.ok(tabID, "the PDF reader tab is open");
      assert.equal(Tabs.selectedID, tabID);
      assert.isFalse(Tabs._tabs.some((t: any) => t.type === "zbr"), "no extra tab");
      const container = win.document.getElementById(tabID);
      const iframe = await waitFor(() => container.querySelector("iframe[zbr-shown]") as HTMLIFrameElement, 30_000);
      const owin = iframe.contentWindow as any;
      const odoc = await waitFor(() => (owin.document.body?.classList.contains("ready") ? owin.document : null), 120_000);
      const back = odoc.getElementById("btn-back-pdf") as HTMLElement;
      assert.isFalse(back.hidden, "back-to-PDF button shown");
      // The reader underneath is hidden: its toolbar is a window-drag area that would otherwise
      // swallow real mouse clicks on the page's toolbar.
      const readerBrowser = container.querySelector("browser.reader") as HTMLElement;
      assert.equal(readerBrowser.style.visibility, "hidden");
      assert.equal(win.getComputedStyle(iframe).getPropertyValue("-moz-window-dragging"), "no-drag");
      await snap("19-overlay");
      // Back to the PDF: the view stays loaded, only hidden.
      back.click();
      assert.isFalse(iframe.hasAttribute("zbr-shown"));
      assert.equal(iframe.style.visibility, "hidden");
      assert.equal(readerBrowser.style.visibility, "");
      await snap("19b-overlay-pdf");
      // The bilingual icon in the reader's toolbar brings it back, the same page.
      const reader = Z.Reader.getByTabID(tabID);
      const btn = await waitFor(() => reader._iframeWindow?.document.querySelector("[data-zbr]") as HTMLElement, 30_000);
      btn.click();
      await waitFor(() => iframe.hasAttribute("zbr-shown"), 5000, 20);
      assert.equal(iframe.contentWindow, owin, "same page, not reloaded");
      // Closing the PDF tab disposes of the view.
      Tabs.close(tabID);
      await waitFor(() => !iframe.isConnected, 5000, 20);
      assert.equal(Tabs._tabs.length, tabsBefore - (zbrTab ? 1 : 0));
    } finally {
      Z.Prefs.set("extensions.zotero.zbr.openMode", "tab", true);
      // Later tests use the bilingual tab again.
      await Z.ZBR.api.openBilingual(attachment);
      const tab = Tabs._tabs.find((t: any) => t.type === "zbr");
      const iframe = await waitFor(() => win.document.getElementById(tab.id)?.querySelector("iframe") as HTMLIFrameElement);
      rwin = iframe.contentWindow;
      rdoc = await waitFor(() => (rwin.document.body?.classList.contains("ready") ? rwin.document : null), 120_000);
    }
  });

  it("offers a MinerU cloud parse only where there is no MinerU result, with sign-up steps", async function () {
    const btn = rdoc.getElementById("btn-mineru")!;
    assert.isTrue(btn.hidden, "this paper already has a MinerU parse");
    const saved = Z.Prefs.get("extensions.zotero.zbr.mineruToken", true);
    Z.Prefs.set("extensions.zotero.zbr.mineruToken", "", true);
    try {
      btn.hidden = false;
      btn.click();
      const box = await waitFor(() => rdoc.querySelector(".ho-panel .mn-token"), 3000, 20);
      const panel = rdoc.querySelector(".ho-panel")!;
      assert.include(panel.textContent!, "API 管理");
      assert.include(panel.textContent!, "不解析也能正常阅读");
      assert.equal((box as HTMLInputElement).type, "password");
      await snap("17-mineru-dialog");
      // Without a token nothing is sent.
      (panel.querySelector(".ho-actions button") as HTMLElement).click();
      await sleep(200);
      assert.isTrue((panel.querySelector(".ho-status") as HTMLElement).hidden);
      (panel.querySelector(".ho-x") as HTMLElement).click();
    } finally {
      btn.hidden = true;
      Z.Prefs.set("extensions.zotero.zbr.mineruToken", saved ?? "", true);
    }
  });

  it("rebuilds display math and tables from MinerU", async function () {
    (rdoc.querySelector('[data-mode="interleave"]') as HTMLElement).click();
    await sleep(400);
    assert.isFalse((rdoc.getElementById("opt-rich") as HTMLElement).hidden, "MinerU toggle visible");
    const math = rdoc.querySelector("section.k-math")!;
    math.scrollIntoView({ block: "center" });
    await waitFor(() => rdoc.querySelector("figure.tex .katex"), 60_000);
    await snap("04-mineru-math");
    const table = rdoc.querySelector("section.k-table")!;
    table.scrollIntoView({ block: "center" });
    await waitFor(() => rdoc.querySelector("figure.html-table table"), 60_000);
    await snap("05-mineru-table");
  });

  it("crops figures from the PDF with pdf.js", async function () {
    const fig = rdoc.querySelector("section.k-image figure")!;
    fig.scrollIntoView({ block: "center" });
    const img = await waitFor(() => fig.querySelector("img"), 60_000);
    await waitFor(() => (img as HTMLImageElement).naturalWidth > 100, 10_000);
    await snap("06-figure");
  });

  describe("PDF integration", function () {
    let host: any;
    let unit: string;
    before(function () {
      host = rwin.wrappedJSObject.zbrHost;
      unit = [...rdoc.querySelectorAll<HTMLElement>("section.k-paragraph .en .s[data-u]")][20].dataset.u!;
    });

    it("creates a highlight on the original PDF and tints the sentence", async function () {
      const span = rdoc.querySelector<HTMLElement>(`.en .s[data-u="${unit}"]`)!;
      span.scrollIntoView({ block: "center" });
      await sleep(300);
      // Select the sentence and use the colour swatch in the selection bubble, as a user would.
      const range = rdoc.createRange();
      range.selectNodeContents(span);
      rwin.getSelection().removeAllRanges();
      rwin.getSelection().addRange(range);
      rdoc.dispatchEvent(new rwin.MouseEvent("mouseup", { bubbles: true }));
      const swatch = await waitFor(() => rdoc.querySelector<HTMLElement>(".peek .swatch"), 3000);
      swatch.click();
      const a = await waitFor(() => attachment.getAnnotations()[0], 5000);
      assert.equal(attachment.getAnnotations().length, 1);
      // "高亮附译文" is off by default: the comment stays the reader's own.
      assert.isFalse((rdoc.getElementById("opt-hlzh") as HTMLInputElement).checked);
      assert.notOk(a.annotationComment, "no comment");
      assert.equal(a.annotationType, "highlight");
      assert.match(a.annotationSortIndex, /^\d{5}\|\d{6}\|\d{5}$/);
      assert.include(span.textContent!.trim(), a.annotationText.slice(0, 30));
      const pos = JSON.parse(a.annotationPosition);
      assert.isAbove(pos.rects.length, 0);
      await waitFor(() => span.classList.contains("marked") && rdoc.querySelector(`.zh .s.marked[data-u="${unit}"]`), 5000);
      // Only the highlighted sentence (and at most a neighbour sharing its lines) is tinted.
      assert.isAtMost(new Set([...rdoc.querySelectorAll<HTMLElement>(".s.marked")].map((e) => e.dataset.u)).size, 2);
      await snap("07-highlight");
    });

    it("opens the highlight card on click and edits the comment and colour", async function () {
      const span = rdoc.querySelector<HTMLElement>(`.en .s.marked[data-u="${unit}"]`)!;
      span.dispatchEvent(new rwin.MouseEvent("mouseup", { bubbles: true }));
      span.click();
      const card = await waitFor(() => [...rdoc.querySelectorAll<HTMLElement>(".peek")].find((p) => /高亮批注/.test(p.textContent!)), 3000);
      assert.include(card.textContent!, "（无批注）");
      const [a] = attachment.getAnnotations();
      await host.updateHighlight({ id: a.key, comment: "测试批注", color: "#2ea8e5" });
      assert.equal(a.annotationComment, "测试批注");
      assert.equal(a.annotationColor, "#2ea8e5");
      await waitFor(() => span.style.getPropertyValue("--mark") === "#2ea8e5", 3000);
      rdoc.dispatchEvent(new rwin.KeyboardEvent("keydown", { key: "Escape" }));
    });

    it("puts the translation into the comment when 高亮附译文 is ticked", async function () {
      const box = rdoc.getElementById("opt-hlzh") as HTMLInputElement;
      box.click();
      await waitFor(async () => (await host.getPrefs()).highlightWithZh === true, 3000, 50);
      const other = [...rdoc.querySelectorAll<HTMLElement>("section.k-paragraph .en .s[data-u]")][24];
      other.scrollIntoView({ block: "center" });
      await sleep(300);
      const range = rdoc.createRange();
      range.selectNodeContents(other);
      rwin.getSelection().removeAllRanges();
      rwin.getSelection().addRange(range);
      rdoc.dispatchEvent(new rwin.MouseEvent("mouseup", { bubbles: true }));
      (await waitFor(() => rdoc.querySelector<HTMLElement>(".peek .swatch"), 3000)).click();
      const a = await waitFor(() => attachment.getAnnotations().find((x: any) => /^【译】/.test(x.annotationComment)), 5000);
      assert.match(a.annotationComment, /^【译】.*[一-鿿]/);
      other.dispatchEvent(new rwin.MouseEvent("mouseup", { bubbles: true }));
      other.click();
      await waitFor(() => [...rdoc.querySelectorAll<HTMLElement>(".peek")].find((p) => /【译】/.test(p.textContent!)), 3000);
      await snap("07b-highlight-card");
      rdoc.dispatchEvent(new rwin.KeyboardEvent("keydown", { key: "Escape" }));
      await a.eraseTx();
      box.click();
      await waitFor(async () => (await host.getPrefs()).highlightWithZh === false, 3000, 50);
    });

    it("drops the tint when the annotation is deleted elsewhere", async function () {
      const [a] = attachment.getAnnotations();
      await a.eraseTx();
      await waitFor(() => !rdoc.querySelector(".s.marked"), 5000);
    });

    it("opens the PDF at the sentence without hijacking the PDF tab lookup", async function () {
      const win = Zotero.getMainWindow() as any;
      assert.isUndefined(win.Zotero_Tabs.getTabIDByItemID(attachment.id), "bilingual tab must not look like a PDF tab");
      // A sentence on a later page, so a missing jump would leave the view on page 1.
      const doc = await host.getDocument();
      const far = doc.blocks.find((b: any) => b.sentences.length && b.pageRects[0]?.[0] >= 4);
      await host.openInPdf({ blockId: far.id, unitIds: [far.sentences[0].id] });
      const reader = await waitFor(() => Z.Reader._readers.find((r: any) => r.itemID === attachment.id), 30_000);
      assert.equal(win.Zotero_Tabs.selectedID, reader.tabID);
      // The reader toolbar's page box shows the label of the page the view is on.
      const label = doc.pages[far.pageRects[0][0]].label ?? String(far.pageRects[0][0] + 1);
      const pageBox = (): string[] => {
        try {
          return Array.from(reader._iframeWindow.document.querySelectorAll("input"), (x: any) => String(x.value));
        } catch (e) {
          return [`(${e})`];
        }
      };
      await waitFor(() => pageBox().includes(label), 20_000).catch(async () => {
        await snap("08-open-in-pdf-fail");
        throw new Error(`PDF page box ${JSON.stringify(pageBox())}, expected ${label}`);
      });
      await sleep(800);
      await snap("08-open-in-pdf");
      // The PDF reader toolbar carries the "双语阅读" button.
      const rd = reader._iframeWindow.document;
      const diag = {
        buttons: Array.from(rd.querySelectorAll("button"), (b: any) => b.title || b.getAttribute("aria-label") || b.className).slice(0, 80),
        custom: Array.from(rd.querySelectorAll(".custom-sections, [class*=custom]"), (e: any) => e.className + ":" + e.childElementCount),
      };
      await IOUtils.writeJSON(PathUtils.join(outDir(), "diag-toolbar.json"), diag);
      assert.ok(rd.querySelector('button[title="双语阅读"]'), "toolbar button present");
      win.Zotero_Tabs.close(reader.tabID);
      const zbr = win.Zotero_Tabs._tabs.find((t: any) => t.type === "zbr");
      win.Zotero_Tabs.select(zbr.id);
      await sleep(500);
    });
  });

  describe("translation scheduler (fake engine, no paid calls)", function () {
    let calls: string[][];
    let active = 0;
    let maxActive = 0;
    /** While set, the fake engine fails every request (to exercise failure and retry). */
    let failing = false;
    let fakeEngine: () => any;
    let host: any;
    let events: Record<string, string>;
    const paragraphs = () =>
      [...rdoc.querySelectorAll<HTMLElement>("section.k-paragraph.done")].map((s) => s.dataset.b!).slice(10, 16);

    before(async function () {
      fakeEngine = () => ({
          id: "test:fake",
          label: "Fake",
          async complete(p: any, signal: AbortSignal) {
            // The paper glossary request is answered at once and not counted as a batch.
            if (/terminology list/.test(p.system)) return JSON.stringify({ terms: [] });
            // The user prompt is one instruction line followed by the JSON payload.
            const payload = JSON.parse(p.user.slice(p.user.indexOf("\n") + 1));
            const units: { id: string; en: string }[] = payload.paragraphs.flatMap((x: any) => x.units);
            calls.push(units.map((u: any) => u.id));
            active++;
            maxActive = Math.max(maxActive, active);
            try {
              await sleep(400);
              if (signal?.aborted) throw new Error("aborted");
              if (failing) throw new Error("fake failure");
              return JSON.stringify({ translations: units.map((u: any) => ({ id: u.id, zh: `【测试】${u.en}` })) });
            } finally {
              active--;
            }
          },
        });
      Z.ZBR.api.registerEngine({ id: "test:fake", label: "Fake", kind: "mock", ready: true }, fakeEngine, 1);
      // Small batches so several jobs exist and the concurrency limit actually matters.
      Z.Prefs.set("extensions.zotero.zbr.batchChars", 300, true);
      host = rwin.wrappedJSObject.zbrHost;
      await host.setPrefs({ engineId: "test:fake" });
      events = {};
      host.subscribe((ev: any) => {
        if (ev.type === "translations") for (const [id, u] of Object.entries<any>(ev.units)) events[id] = u.zh;
      });
    });

    after(function () {
      Z.ZBR.api.unregisterEngine("test:fake");
      Z.Prefs.clear("extensions.zotero.zbr.batchChars", true);
    });

    it("retranslates with concurrency 1, no duplicate units, and updates the page", async function () {
      calls = [];
      maxActive = 0;
      const ids = paragraphs().slice(0, 3);
      // Two overlapping requests for the same paragraphs must not translate anything twice.
      await Promise.all([host.translate({ blockIds: ids, retranslate: true }), host.translate({ blockIds: ids, retranslate: true })]);
      lastStep = "retranslate wait";
      try {
        await waitFor(() => !active && calls.length && Object.keys(events).length >= calls.flat().length, 20_000);
      } catch (e) {
        const missing = calls.flat().filter((id) => !(id in events));
        lastStep = `active=${active} calls=${JSON.stringify(calls)} missing=${JSON.stringify(missing)} progress=${rdoc.getElementById("progress")?.textContent}`;
        throw e;
      }
      const flat = calls.flat();
      assert.equal(new Set(flat).size, flat.length, `duplicate units: ${JSON.stringify(calls)}`);
      assert.isAbove(calls.length, 1, "several batches were needed");
      assert.equal(maxActive, 1, "concurrency limit");
      const first = flat[0];
      const span = rdoc.querySelector(`.zh .s[data-u="${first}"]`)!;
      assert.match(span.textContent!, /^【测试】/, "page shows the new translation");
    });

    it("cancel stops queued work and ignores late results", async function () {
      calls = [];
      const ids = paragraphs().slice(3, 6);
      void host.translate({ blockIds: ids, retranslate: true });
      await waitFor(() => calls.length === 1, 5000, 20);
      await host.cancel();
      const before = Object.keys(events).length;
      await sleep(1500);
      assert.equal(calls.length, 1, "no new batches after cancel");
      assert.equal(Object.keys(events).length, before, "late result of the cancelled batch is dropped");
    });

    it("applies a changed concurrency limit without reopening the paper", async function () {
      Z.ZBR.api.registerEngine({ id: "test:fake", label: "Fake", kind: "mock", ready: true }, fakeEngine, 3);
      calls = [];
      maxActive = 0;
      await host.translate({ blockIds: paragraphs().slice(0, 4), retranslate: true });
      await waitFor(() => !active && calls.length >= 3, 30_000);
      assert.isAbove(maxActive, 1, `max parallel ${maxActive}`);
      Z.ZBR.api.registerEngine({ id: "test:fake", label: "Fake", kind: "mock", ready: true }, fakeEngine, 1);
    });

    it("retries failed units when their paragraph is retranslated", async function () {
      const [bid] = paragraphs().slice(5, 6);
      calls = [];
      failing = true;
      await host.translate({ blockIds: [bid], retranslate: true });
      await waitFor(() => !active && calls.length >= 3, 30_000); // first try + 2 retries
      const failedCalls = calls.length;
      failing = false;
      await host.translate({ blockIds: [bid], retranslate: true });
      await waitFor(() => calls.length > failedCalls && !active, 30_000);
      const firstUnit = calls.at(-1)![0];
      await waitFor(() => events[firstUnit], 10_000);
    });

    it("translates one paragraph from the button beside it", async function () {
      const [bid] = paragraphs().slice(2, 3);
      const section = rdoc.querySelector<HTMLElement>(`section.blk[data-b="${bid}"]`)!;
      section.scrollIntoView({ block: "center" });
      section.querySelector(".en .s")!.dispatchEvent(new rwin.MouseEvent("mouseover", { bubbles: true }));
      const btn = rdoc.getElementById("blk-action") as HTMLButtonElement;
      await waitFor(() => !btn.hidden && btn.classList.contains("k-retranslate"), 5000);
      await sleep(100); // placed in the next frame
      const r = btn.getBoundingClientRect();
      const s = section.getBoundingClientRect();
      assert.isAtLeast(r.left, s.right - 30, "button sits in the right margin");
      assert.isBelow(Math.abs(r.top - s.top), 20, "level with the paragraph's first line");
      calls = [];
      btn.click();
      assert.isTrue(btn.classList.contains("k-busy"), "spinner while the paragraph is out");
      await waitFor(() => calls.length && !active && btn.classList.contains("k-retranslate"), 30_000);
      for (const id of calls.flat()) assert.isTrue(id.startsWith(`${bid}:`), `${id} belongs to the paragraph`);
      section.scrollIntoView({ block: "center" });
      await sleep(600);
      section.querySelector(".en .s")!.dispatchEvent(new rwin.MouseEvent("mouseover", { bubbles: true }));
      await snap("15-paragraph-button");
    });

    it("retries only the failed sentences from the toolbar", async function () {
      const [bid] = paragraphs().slice(4, 5);
      calls = [];
      failing = true;
      let retry: HTMLButtonElement;
      try {
        await host.translate({ blockIds: [bid], retranslate: true });
        retry = await waitFor(() => rdoc.querySelector<HTMLButtonElement>("#btn-retry-failed:not([disabled])"), 30_000);
      } finally {
        failing = false;
      }
      const shown = Number(/失败 (\d+) 句/.exec(retry.textContent!)![1]);
      calls = [];
      retry.click();
      await waitFor(() => calls.length && !active && !rdoc.getElementById("btn-retry-failed"), 30_000);
      const retried = calls.flat();
      assert.isTrue(retried.some((id) => id.startsWith(`${bid}:`)), "the failed paragraph is retried");
      // Failures from earlier in the session count too; nothing beyond the failed sentences is sent.
      assert.isAtMost(retried.length, shown, `calls=${JSON.stringify(calls)}`);
    });

    it("shows the MinerU source with typeset inline formulas in both languages", async function () {
      const source = rdoc.getElementById("opt-source") as HTMLSelectElement;
      await waitFor(() => !source.hidden, 30_000);
      source.value = "mineru";
      source.dispatchEvent(new rwin.Event("change", { bubbles: true }));
      await waitFor(() => rdoc.querySelector('section.blk[data-b^="m"]'), 20_000);
      assert.isNull(rdoc.querySelector('section.blk[data-b="12"]'), "Zotero blocks are gone");
      const block = await waitFor(() => rdoc.querySelector<HTMLElement>("section.k-paragraph:has(.en .ktx .katex)"), 10_000);
      block.scrollIntoView({ block: "center" });
      await host.translate({ blockIds: [block.dataset.b], retranslate: true });
      await waitFor(() => block.querySelector(".zh .s:not(.pending) .ktx .katex"), 20_000);
      assert.match(block.querySelector(".zh")!.textContent!, /【测试】/);
      await snap("09-mineru-source");
      // Highlights on MinerU text go to the PDF through the aligned Zotero text, and show here.
      assert.isFalse((rdoc.getElementById("opt-hlzh-wrap") as HTMLElement).hidden);
      const plain = [...rdoc.querySelectorAll<HTMLElement>('section.k-paragraph[data-b^="m"] .en .s[data-u]')].filter((e) => !e.querySelector(".ktx") && e.textContent!.length > 80)[10];
      plain.scrollIntoView({ block: "center" });
      const n0 = attachment.getAnnotations().length;
      await host.createHighlight({ unitIds: [plain.dataset.u], color: "#ffd400" });
      const a = await waitFor(() => attachment.getAnnotations().length > n0 && attachment.getAnnotations().find((x: any) => !x.annotationComment), 5000);
      const words = (t: string) => t.toLowerCase().replace(/[^a-z]/g, "");
      assert.equal(words(a.annotationText), words(plain.textContent!), "PDF highlight covers the same words");
      await waitFor(() => plain.classList.contains("marked"), 5000);
      plain.scrollIntoView({ block: "center" });
      await sleep(300);
      await snap("09b-mineru-highlight");
      await a.eraseTx();
      await waitFor(() => !plain.classList.contains("marked"), 5000);
      // "Locate in PDF" from a MinerU sentence opens the PDF at the aligned Zotero text.
      const win = Zotero.getMainWindow() as any;
      await host.openInPdf({ blockId: plain.dataset.u!.split(":")[0], unitIds: [plain.dataset.u] });
      const reader = await waitFor(() => Z.Reader._readers.find((r: any) => r.itemID === attachment.id), 30_000);
      win.Zotero_Tabs.close(reader.tabID);
      win.Zotero_Tabs.select(win.Zotero_Tabs._tabs.find((t: any) => t.type === "zbr").id);
      await sleep(500);
      source.value = "zotero";
      source.dispatchEvent(new rwin.Event("change", { bubbles: true }));
      await waitFor(() => rdoc.querySelector('section.blk[data-b="12"]'), 20_000);
    });

    it("keeps a hand-edited translation and clears the paper's cache on request", async function () {
      const unit = rdoc.querySelector<HTMLElement>("section.k-paragraph.done .zh .s")!.dataset.u!;
      await host.editTranslation(unit, "【手改】这是读者自己的译文。");
      await waitFor(() => rdoc.querySelector(`.zh .s[data-u="${unit}"]`)?.textContent === "【手改】这是读者自己的译文。", 5000);
      assert.equal((await host.getTranslations())[unit].zh, "【手改】这是读者自己的译文。");
      // Light theme: the peek card is no longer a black box.
      assert.notEqual(rwin.getComputedStyle(rdoc.documentElement).getPropertyValue("--peek-bg").trim(), "");
      const before = Object.keys(await host.getTranslations()).length;
      assert.isAbove(before, 10);
      // Only the source on screen: the MinerU-only sentence translated above survives.
      await host.clearTranslations("source");
      assert.equal(Object.keys(await host.getTranslations()).length, 0);
      await host.setPrefs({ source: "mineru" });
      assert.isAbove(Object.keys(await host.getTranslations()).length, 0, "MinerU translations kept");
      await host.setPrefs({ source: "zotero" });
      await host.clearTranslations();
      await host.setPrefs({ source: "mineru" });
      assert.equal(Object.keys(await host.getTranslations()).length, 0, "both sources cleared");
      await host.setPrefs({ source: "zotero" });
    });

    it("hands the whole paper to an agent the reader runs, and follows it through the folder", async function () {
      // The test plays the reader's own agent session: it only reads and writes the task folder.
      await host.clearTranslations();
      (rdoc.getElementById("btn-handoff") as HTMLElement).click();
      const panel = await waitFor(() => rdoc.querySelector<HTMLElement>(".ho-panel"), 10_000);
      const info = await host.getHandoff();
      assert.isAbove(info.todo, 100);
      assert.include(panel.textContent!, info.dir, "the prompt names the task folder");
      assert.match(await IOUtils.readUTF8(PathUtils.join(info.dir, "TASK.md")), /任务目录/);
      const status = () => rdoc.querySelector(".ho-status")?.textContent ?? "";
      await waitFor(() => /等待 Agent 开始/.test(status()), 10_000);
      await snap("12-handoff-panel");
      const file: any = await IOUtils.readJSON(PathUtils.join(info.dir, "units.json"));
      const todo = file.sections.flatMap((s: any) => s.paragraphs.flatMap((p: any) => p.units)).filter((u: any) => !u.zh);
      const write = (name: string, obj: unknown) => IOUtils.writeJSON(PathUtils.join(info.dir, ...name.split("/")), obj);
      await IOUtils.writeUTF8(PathUtils.join(info.dir, "glossary.md"), "wind power = 风电功率\n");
      await waitFor(() => /术语表/.test(status()), 10_000);
      const half = Math.ceil(todo.length / 2);
      await write("parts/01.json", Object.fromEntries(todo.slice(0, half).map((u: any) => [u.id, `【交付】${u.en}`])));
      await waitFor(() => /翻译中：已交付 \d+\/\d+ 句.*最后写入/.test(status()), 10_000);
      assert.match(rdoc.getElementById("progress")!.textContent!, /Agent 翻译中/, "toolbar shows it too");
      // The rest, with one long sentence left in English.
      const rest = todo.slice(half).map((u: any) => [u.id, `【交付】${u.en}`]);
      const left = rest.find(([id]: string[]) => todo.find((u: any) => u.id === id).en.length > 40)!;
      left[1] = todo.find((u: any) => u.id === left[0]).en;
      await write("parts/02.json", Object.fromEntries(rest));
      await waitFor(() => /自查和写报告/.test(status()), 10_000);
      await IOUtils.writeUTF8(PathUtils.join(info.dir, "report.md"), "# 报告\n");
      await waitFor(() => /只交付了/.test(status()), 10_000);
      // Fix round: only the failed sentence goes back.
      [...rdoc.querySelectorAll<HTMLElement>(".ho-actions button")].find((b) => b.textContent === "生成补译提示词")!.click();
      await waitFor(() => IOUtils.exists(PathUtils.join(info.dir, "fix.json")), 10_000);
      await waitFor(() => /发给同一个 Agent 会话/.test(rdoc.querySelector(".ho-panel")?.textContent ?? ""), 10_000);
      const fix = (await IOUtils.readJSON(PathUtils.join(info.dir, "fix.json"))) as any[];
      assert.equal(fix.length, 1);
      assert.equal(fix[0].id, left[0]);
      assert.equal(fix[0].problem, "not translated");
      await write("fix_out.json", { [left[0]]: `【补译】${fix[0].en}` });
      await waitFor(() => /Agent 已完成/.test(status()), 10_000);
      await waitFor(() => rdoc.querySelector(`.zh .s[data-u="${left[0]}"]`)?.textContent?.startsWith("【补译】"), 10_000);
      assert.match((await host.getTranslations())[todo[0].id].zh, /^【交付】/);
      await snap("13-handoff-done");
      panel.closest(".ho-back")!.remove();
    });

    it("makes a paper glossary once and uses it in batch requests", async function () {
      const seen: string[] = [];
      let empty = true;
      const glossaryEngine = () => ({
        id: "test:gloss",
        label: "Gloss",
        async complete(p: any) {
          seen.push(p.system);
          if (/terminology list/.test(p.system)) return JSON.stringify({ terms: empty ? [] : [{ en: "wind power", zh: "风力发电功率" }] });
          const payload = JSON.parse(p.user.slice(p.user.indexOf("\n") + 1));
          return JSON.stringify({ translations: payload.paragraphs.flatMap((x: any) => x.units).map((u: any) => ({ id: u.id, zh: `【术语】${u.en}` })) });
        },
      });
      Z.ZBR.api.registerEngine({ id: "test:gloss", label: "Gloss", kind: "mock", ready: true }, glossaryEngine, 1);
      try {
        await host.clearTranslations();
        await host.setPrefs({ engineId: "test:gloss" });
        // An answer without terms is not kept, so the paper is asked again later.
        await host.translate({ blockIds: paragraphs().slice(0, 1) });
        await waitFor(() => seen.some((s) => !/terminology list/.test(s)), 20_000);
        await sleep(500);
        assert.isNull(await host.getPaperGlossary(), "empty glossary not stored");
        empty = false;
        seen.length = 0;
        await host.clearTranslations();
        const ids = paragraphs().slice(0, 2);
        await host.translate({ blockIds: ids });
        await waitFor(async () => (await host.getPaperGlossary()) !== null, 20_000);
        assert.match(await host.getPaperGlossary(), /wind power = 风力发电功率/);
        assert.equal(seen.filter((s) => /terminology list/.test(s)).length, 1, "made once");
        await host.translate({ blockIds: paragraphs().slice(2, 4), retranslate: true });
        await waitFor(() => seen.some((s) => /风力发电功率/.test(s)), 20_000);
      } finally {
        Z.ZBR.api.unregisterEngine("test:gloss");
        await host.setPrefs({ engineId: "test:fake" });
      }
    });

    it("pre-translates a paper from the library in the background, Zotero and MinerU text", async function () {
      const fast = () => ({
        id: "test:fast",
        label: "Fast",
        async complete(p: any) {
          if (/terminology list/.test(p.system)) return JSON.stringify({ terms: [] });
          const payload = JSON.parse(p.user.slice(p.user.indexOf("\n") + 1));
          return JSON.stringify({ translations: payload.paragraphs.flatMap((x: any) => x.units).map((u: any) => ({ id: u.id, zh: `【预译】${u.en}` })) });
        },
      });
      Z.ZBR.api.registerEngine({ id: "test:fast", label: "Fast", kind: "mock", ready: true }, fast, 8);
      try {
        await host.setPrefs({ engineId: "test:fast", source: "zotero" });
        await host.clearTranslations();
        await sleep(2000);
        await Z.ZBR.api.prefetch([attachment]);
        await waitFor(() => !Z.ZBR.api.isPrefetching(), 120_000);
        const doc = await host.getDocument();
        const total = doc.blocks.filter((b: any) => b.translatable).flatMap((b: any) => b.sentences).length;
        const tr = await host.getTranslations();
        assert.isAtLeast(Object.keys(tr).length, total - 5, "Zotero text translated");
        // The open page picked them up from the cache file.
        await waitFor(() => [...rdoc.querySelectorAll(".zh .s")].filter((s) => s.textContent!.startsWith("【预译】")).length > 50, 15_000);
        const file: any = await IOUtils.readJSON(PathUtils.join(Z.ZBR.api.cacheDir(), `${attachment.libraryID}-${attachment.key}.json`));
        assert.isAbove(Object.keys(file.units).length, Object.keys(tr).length, "MinerU-only sentences translated too");
      } finally {
        Z.ZBR.api.unregisterEngine("test:fast");
        await host.setPrefs({ engineId: "test:fake" });
      }
    });

    it("shows translations another program writes to the cache file while the paper is open", async function () {
      const [unit, cur] = Object.entries<any>(await host.getTranslations()).find(([, u]) => u.zh)!;
      const file = PathUtils.join(Z.ZBR.api.cacheDir(), `${attachment.libraryID}-${attachment.key}.json`);
      await sleep(2000); // let the reader's own pending write land first
      const data: any = await IOUtils.readJSON(file);
      data.units[cur.srcHash] = { zh: "【外部写入】批量翻译工具写进来的译文。", engine: "cli:test", prompt: "p4", glossary: "", t: Date.now() + 1000 };
      await IOUtils.writeJSON(file, data);
      // The open page shows it within a few seconds, without reopening.
      await waitFor(() => rdoc.querySelector(`.zh .s[data-u="${unit}"]`)?.textContent === "【外部写入】批量翻译工具写进来的译文。", 15_000);
      assert.equal((await host.getTranslations())[unit].zh, "【外部写入】批量翻译工具写进来的译文。");
      // The reader's next write keeps it (merged, not overwritten).
      await host.editTranslation(Object.keys(await host.getTranslations()).find((id) => id !== unit), "【手改】另一句。");
      await host.setPosition("x");
      await sleep(2500);
      const after: any = await IOUtils.readJSON(file);
      assert.equal(after.units[cur.srcHash].zh, "【外部写入】批量翻译工具写进来的译文。");
    });
  });

  it("settings: one labelled card per agent with model and effort menus", async function () {
    const pwin = Z.Utilities.Internal.openPreferences(Z.ZBR.prefPaneID);
    const cards = await waitFor(() => {
      const list = pwin.document?.querySelectorAll(".zbr-agent");
      return list?.length === 3 && [...list].every((c: Element) => !/检测中/.test(c.textContent!)) ? list : null;
    }, 30_000);
    const grok = cards[0] as HTMLElement;
    const [modelSel, effortSel] = grok.querySelectorAll("menulist") as any;
    assert.match(grok.textContent!, /模型/);
    assert.match(grok.textContent!, /思考强度/);
    assert.isAbove(modelSel.itemCount, 2, "listed models + default + custom");
    assert.match(effortSel.getItemAtIndex(0).label, /跟随/);
    // The menus really open and a choice is saved (an HTML <select> popup never showed here).
    const choose = async (ml: any, index: number) => {
      ml.open = true;
      await waitFor(() => ml.menupopup.state === "open", 5000, 20);
      ml.menupopup.activateItem(ml.getItemAtIndex(index));
      await waitFor(() => ml.menupopup.state === "closed", 5000, 20);
    };
    await choose(modelSel, 1);
    assert.equal(Z.Prefs.get("extensions.zotero.zbr.grokModel", true), modelSel.getItemAtIndex(1).value);
    await choose(effortSel, 1);
    assert.equal(Z.Prefs.get("extensions.zotero.zbr.grokEffort", true), effortSel.getItemAtIndex(1).value);
    Z.Prefs.set("extensions.zotero.zbr.grokModel", "", true);
    Z.Prefs.set("extensions.zotero.zbr.grokEffort", "", true);
    pwin.document.querySelector("#zbr-prefs")?.scrollIntoView();
    await snap("11a-settings-top", pwin);
    grok.scrollIntoView();
    await snap("11-settings", pwin);
    pwin.close();
  });

  it("settings: API providers, each ticked model a separate engine", async function () {
    Z.Prefs.set("extensions.zotero.zbr.apiProviders", "", true);
    const pwin = Z.Utilities.Internal.openPreferences(Z.ZBR.prefPaneID);
    const add = await waitFor(() => pwin.document?.getElementById("zbr-api-add-cpa"), 30_000);
    add.click();
    const card = await waitFor(() => pwin.document.querySelector(".zbr-api") as HTMLElement, 5000);
    const inputs = card.querySelectorAll("input");
    const key = [...inputs].find((i: any) => i.type === "password") as HTMLInputElement;
    key.value = "test-key";
    key.dispatchEvent(new pwin.Event("change"));
    const typed = [...inputs].find((i: any) => i.placeholder === "模型名") as HTMLInputElement;
    typed.value = "second-model";
    [...card.querySelectorAll("button")].find((b) => b.textContent === "添加")!.click();
    const ids = async () => (await Z.ZBR.api.listEngines()).filter((e: any) => e.kind === "api").map((e: any) => `${e.id}${e.ready ? "" : "?"}`);
    assert.deepEqual(await ids(), ["api:p1:k3-256k", "api:p1:second-model"]);
    // Unticking a model removes its engine.
    const cb = card.querySelector('input[data-model="second-model"]') as HTMLInputElement;
    cb.checked = false;
    cb.dispatchEvent(new pwin.Event("change"));
    assert.deepEqual(await ids(), ["api:p1:k3-256k"]);
    const saved = JSON.parse(Z.Prefs.get("extensions.zotero.zbr.apiProviders", true));
    assert.include(saved[0], { base: "http://127.0.0.1:8317/v1", concurrency: 16, effort: "low", key: "test-key" });
    pwin.document.getElementById("zbr-apis").scrollIntoView();
    await snap("11b-settings-api", pwin);
    [...card.querySelectorAll("button")].find((b) => b.textContent === "删除服务商")!.click();
    assert.deepEqual(await ids(), []);
    pwin.close();
    Z.Prefs.set("extensions.zotero.zbr.apiProviders", "", true);
  });

  it("finds the npm-installed Codex CLI's native binary", async function (this: any) {
    const engines = await Z.ZBR.api.listEngines();
    const codex = engines.find((e: any) => e.id === "agent:codex");
    if (!codex?.ready) return this.skip();
    await IOUtils.writeJSON(PathUtils.join(outDir(), "diag-engines.json"), engines);
    // This machine has `npm i -g @openai/codex`; it must win over the desktop app's copy.
    assert.match(codex.note, /codex-win32-[a-z0-9]+[\\/]vendor[\\/].*codex\.exe$/i);
  });

  it("translates through a live agent engine (ZBR_TEST_LIVE=1)", async function (this: any) {
    if (!Z.Prefs.get(`${PREFIX}.live`, true)) return this.skip();
    const engines = await Z.ZBR.api.listEngines();
    const grok = engines.find((e: any) => e.id === "agent:grok");
    if (!grok?.ready) return this.skip();
    const { engine } = await Z.ZBR.api.getEngine("agent:grok");
    const batch = {
      paragraphs: [{ blockId: "t", kind: "paragraph", units: [{ id: "t:0", en: "Wind power forecasting reduces the reserve cost of power systems." }] }],
      ids: ["t:0"],
      chars: 64,
    };
    const r = await Z.ZBR.api.runBatch(engine, batch, {});
    assert.deepEqual(r.failed, []);
    assert.match(r.ok["t:0"], /风/);
  });
  // Last: it moves the bilingual tab into a window.
  describe("pop-out window", function () {
    it("moves the page to a window of its own on the right half of the screen", async function () {
      const main = Zotero.getMainWindow() as any;
      const tabCount = () => main.Zotero_Tabs._tabs.filter((t: any) => t.type === "zbr").length;
      if (!tabCount()) await Z.ZBR.api.openBilingual(attachment);
      const tab = main.Zotero_Tabs._tabs.find((t: any) => t.type === "zbr");
      const iframe = await waitFor(() => main.document.getElementById(tab.id)?.querySelector("iframe") as HTMLIFrameElement);
      const page = await waitFor(() => (iframe.contentWindow?.document?.body?.classList.contains("ready") ? iframe.contentWindow!.document : null), 120_000);
      const btn = page.getElementById("btn-popout") as HTMLElement;
      assert.isFalse(btn.hidden, "button shown in a tab");
      btn.click();
      const readerWin = () => {
        for (const w of Services.wm.getEnumerator(null) as any) if (String(w.location?.href).endsWith("/reader/index.html")) return w;
        return null;
      };
      const w = await waitFor(readerWin, 20_000);
      const wdoc = await waitFor(() => (w.document?.body?.classList.contains("ready") ? w.document : null), 120_000);
      assert.equal(tabCount(), 0, "the tab is gone");
      assert.isAbove(wdoc.querySelectorAll("section.blk").length, 150, "paper rendered in the window");
      assert.isTrue((wdoc.getElementById("btn-popout") as HTMLElement).hidden, "no pop-out from a window");
      assert.isAtLeast(w.screenX + w.outerWidth / 2, main.screen.availLeft + main.screen.availWidth / 2, `right half: x=${w.screenX} w=${w.outerWidth} screen=${main.screen.availLeft}+${main.screen.availWidth}`);
      await snap("14-popout-window", w);
      // Opening the paper again focuses its window instead of adding a tab.
      await Z.ZBR.api.openBilingual(attachment);
      assert.equal(tabCount(), 0);
      w.close();
      await waitFor(() => !readerWin(), 10_000);
    });
  });
});
