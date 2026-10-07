// Opens the bilingual reader in a Zotero tab: a chrome iframe hosting reader/index.html, with the
// host object injected into its window.

import { config } from "../../package.json";
import { createHost, type ZoteroHost } from "./host";
import { getPref } from "./prefs";

export const TAB_TYPE = "zbr";
const READER_URL = `chrome://${config.addonRef}/content/reader/index.html`;

const hosts = new Map<string, ZoteroHost>();

/** A PDF attachment for an item: the item itself, or the regular item's best attachment. */
export async function resolveAttachment(item: any): Promise<any | null> {
  if (!item) return null;
  if (item.isAttachment?.()) return item.isPDFAttachment?.() ? item : null;
  if (item.isRegularItem?.()) {
    const best = await item.getBestAttachment();
    return best?.isPDFAttachment?.() ? best : null;
  }
  return null;
}

export function canOpen(item: any): boolean {
  if (!item) return false;
  if (item.isAttachment?.()) return !!item.isPDFAttachment?.();
  return !!item.isRegularItem?.() && item.numAttachments?.() > 0;
}

function tabTitle(attachment: any): string {
  const parent = attachment.parentItem;
  const title = (parent ?? attachment).getField?.("title") || attachment.attachmentFilename || "PDF";
  return `双语 · ${title}`;
}

/** "overlay": a view inside the PDF's own tab, switched with a button; "tab": a tab of its own. */
export function openMode(): "overlay" | "tab" {
  return getPref("openMode") === "tab" ? "tab" : "overlay";
}

export async function openBilingual(item: any) {
  const attachment = await resolveAttachment(item);
  const win = Zotero.getMainWindow() as any;
  if (!attachment) {
    win.alert("没有找到可用的 PDF 附件。");
    return;
  }
  if (openMode() === "overlay") return showOverlay(attachment);
  const popped = windows.get(attachment.id);
  if (popped && !popped.closed) {
    popped.focus();
    return;
  }
  const Tabs = win.Zotero_Tabs;
  const existing = Tabs._tabs.find((t: any) => t.type === TAB_TYPE && t.data?.zbrItemID === attachment.id);
  if (existing) {
    Tabs.select(existing.id);
    return;
  }
  // Right after the PDF's own reader tab when it is open, otherwise after the current tab.
  const pdfTab = Tabs.getTabIDByItemID(attachment.id);
  const after = Tabs._tabs.findIndex((t: any) => t.id === (pdfTab || Tabs.selectedID));
  const { id, container } = Tabs.add({
    type: TAB_TYPE,
    index: after < 0 ? undefined : after + 1,
    title: tabTitle(attachment),
    // Not `itemID`: Zotero_Tabs.getTabIDByItemID would then treat this tab as the PDF reader tab.
    // `companionOf` tells other plugins (tab groups and the like) which PDF this page belongs
    // to, so they can keep it next to that PDF; nothing here depends on anyone reading it.
    data: { zbrItemID: attachment.id, companionOf: { itemID: attachment.id, parentItemID: attachment.parentItemID ?? null } },
    select: true,
    onClose: () => {
      hosts.get(id)?.dispose();
      hosts.delete(id);
    },
  });
  const host = createHost(attachment);
  hosts.set(id, host);
  // The page's "新窗口" button: the reading position is kept in the cache, so the window opens there.
  host.popOut = async () => {
    Tabs.close(id);
    await openBilingualWindow(attachment);
  };
  const iframe = makeReaderFrame(win.document, host);
  iframe.setAttribute("flex", "1");
  iframe.style.cssText = "border:0;width:100%;height:100%;display:block;";
  (container as HTMLElement).style.display = "flex";
  container.append(iframe);
}

const windows = new Map<number, Window>();

/** Bilingual views laid over PDF reader tabs, by tab id. */
const overlays = new Map<string, { iframe: HTMLIFrameElement; host: ZoteroHost; itemID: number }>();
let tabObserverID: string | null = null;

function setOverlayShown(tabID: string, shown: boolean) {
  const o = overlays.get(tabID);
  if (!o) return;
  // Hidden with visibility, not display: the page keeps its layout and scroll position.
  o.iframe.style.visibility = shown ? "visible" : "hidden";
  o.iframe.toggleAttribute("zbr-shown", shown);
  // The reader's toolbar is a window-drag area (-moz-window-dragging): even covered, it would
  // turn clicks on the page's toolbar into dragging the window. Hidden, it takes no part.
  const win = Zotero.getMainWindow() as any;
  const reader = win.document.getElementById(tabID)?.querySelector("browser.reader") as HTMLElement | null;
  if (reader) reader.style.visibility = shown ? "hidden" : "";
  // The reader underneath keeps its place; keys go to whichever view is on top.
  if (shown) o.iframe.focus();
  else (Zotero as any).Reader.getByTabID?.(tabID)?.focus?.();
  win.document.getElementById(tabID)?.toggleAttribute("zbr-bilingual", shown);
}

function disposeOverlay(tabID: string) {
  const o = overlays.get(tabID);
  if (!o) return;
  setOverlayShown(tabID, false);
  overlays.delete(tabID);
  o.host.dispose();
  o.iframe.remove();
}

/**
 * The bilingual page as a second view of the PDF's own reader tab: laid over the reader, hidden
 * again with the page's "返回 PDF" button. No extra tab; both views keep their reading position.
 */
export async function showOverlay(attachment: any) {
  const popped = windows.get(attachment.id);
  if (popped && !popped.closed) {
    popped.focus();
    return;
  }
  const win = Zotero.getMainWindow() as any;
  const Tabs = win.Zotero_Tabs;
  // A bilingual tab of this PDF opened earlier (the other mode): use that.
  const tab = Tabs._tabs.find((t: any) => t.type === TAB_TYPE && t.data?.zbrItemID === attachment.id);
  if (tab) {
    Tabs.select(tab.id);
    return;
  }
  let tabID = Tabs.getTabIDByItemID(attachment.id);
  const loaded = tabID && Tabs._getTab(tabID)?.tab?.type === "reader";
  if (!loaded) {
    const reader = await (Zotero as any).Reader.open(attachment.id);
    tabID = reader?.tabID ?? Tabs.getTabIDByItemID(attachment.id);
  } else Tabs.select(tabID);
  const container = tabID && (win.document.getElementById(tabID) as HTMLElement | null);
  if (!container) return;
  const existing = overlays.get(tabID);
  if (existing?.iframe.isConnected) return setOverlayShown(tabID, true);
  if (existing) disposeOverlay(tabID);

  // The reader tab is unloaded after a while unused, which removes its container: drop ours.
  tabObserverID ??= Zotero.Notifier.registerObserver(
    {
      notify(event: string, _type: string, ids: string[]) {
        if (event === "close") for (const id of ids) disposeOverlay(id);
      },
    } as any,
    ["tab"],
    "zbr-overlays",
  );

  const host = createHost(attachment);
  host.backToPdf = () => setOverlayShown(tabID, false);
  host.popOut = async () => {
    disposeOverlay(tabID);
    await openBilingualWindow(attachment);
  };
  // Showing a sentence or highlight in the PDF reveals the reader under the overlay first.
  const openInPdf = host.openInPdf.bind(host);
  const openHighlight = host.openHighlight.bind(host);
  host.openInPdf = (target) => {
    setOverlayShown(tabID, false);
    return openInPdf(target);
  };
  host.openHighlight = (id) => {
    setOverlayShown(tabID, false);
    return openHighlight(id);
  };
  const iframe = makeReaderFrame(win.document, host);
  // Over the whole reader (its toolbar and sidebars too); the item pane on the right stays.
  iframe.style.cssText = "border:0;position:absolute;inset:0;width:100%;height:100%;z-index:5;background:var(--material-background, #fff);";
  iframe.style.setProperty("-moz-window-dragging", "no-drag");
  if (!container.style.position) container.style.position = "relative";
  container.append(iframe);
  overlays.set(tabID, { iframe, host, itemID: attachment.id });
  setOverlayShown(tabID, true);
}

/** Whether the PDF of this reader tab currently shows the bilingual view. */
export function overlayShown(tabID: string): boolean {
  const o = overlays.get(tabID);
  return !!o && o.iframe.hasAttribute("zbr-shown");
}

/** The reader page in a chrome iframe, given its host once the page has loaded. */
function makeReaderFrame(doc: Document, host: ZoteroHost): HTMLIFrameElement {
  const iframe = doc.createElementNS("http://www.w3.org/1999/xhtml", "iframe") as HTMLIFrameElement;
  iframe.setAttribute("src", READER_URL);
  // The iframe first fires "load" for its initial about:blank document, so only inject into the
  // reader page; a reload creates a new document, which gets the host again.
  const inject = () => {
    const w = iframe.contentWindow as any;
    if (!w || w.location.href !== READER_URL) return;
    // Plugin code sees the page through an Xray wrapper; an expando set on the wrapper is
    // invisible to the page's own script, so write through to the underlying window.
    const page = w.wrappedJSObject ?? w;
    if (page.zbrHost) return;
    page.zbrHost = host;
    w.dispatchEvent(new w.Event("zbr-host-ready"));
  };
  iframe.addEventListener("load", inject, true);
  return iframe;
}

export function closeOverlays() {
  for (const id of [...overlays.keys()]) disposeOverlay(id);
  if (tabObserverID) Zotero.Notifier.unregisterObserver(tabObserverID);
  tabObserverID = null;
}

/**
 * The bilingual page in a window of its own, on the right half of the screen: with Zotero's
 * window on the left (Win+←) the PDF and its translation sit side by side.
 */
export async function openBilingualWindow(attachment: any) {
  const open = windows.get(attachment.id);
  if (open && !open.closed) {
    open.focus();
    return;
  }
  const main = Zotero.getMainWindow() as any;
  const scr = main.screen;
  const width = Math.round(scr.availWidth / 2);
  const place = { left: scr.availLeft + width, top: scr.availTop, width, height: scr.availHeight };
  const features = `chrome,resizable,dialog=no,width=${place.width},height=${place.height},left=${place.left},top=${place.top}`;
  const w = (Services as any).ww.openWindow(null, READER_URL, "_blank", features, null) as any;
  windows.set(attachment.id, w);
  const host = createHost(attachment);
  const inject = () => {
    if (w.location.href !== READER_URL) return;
    const page = w.wrappedJSObject ?? w;
    if (page.zbrHost) return;
    page.zbrHost = host;
    w.dispatchEvent(new w.Event("zbr-host-ready"));
    // The open features alone are not always honoured (display scaling); place it again.
    w.moveTo(place.left, place.top);
    w.resizeTo(place.width, place.height);
    w.addEventListener(
      "unload",
      () => {
        host.dispose();
        if (windows.get(attachment.id) === w) windows.delete(attachment.id);
      },
      { once: true },
    );
  };
  w.addEventListener("DOMContentLoaded", inject);
  w.addEventListener("load", inject);
}

/**
 * Bilingual tabs are not written into the saved session: Zotero's restoreState expects a hook
 * for every tab type, and a saved tab of an unknown type would break restoring all tabs if the
 * plugin were disabled. Reopening is one click.
 *
 * Filtered where the session is built (ZoteroPane.getState), not in Zotero_Tabs.getState: other
 * plugins read Zotero_Tabs.getState next to Zotero_Tabs._tabs and pair them by index, so that
 * list must keep every tab.
 */
export function patchTabs(win: any) {
  const pane = win.ZoteroPane;
  if (!pane?.getState || pane.__zbrOrigGetState) return;
  const orig = pane.getState;
  const wrapper = function (this: any, ...args: any[]) {
    const state = orig.apply(this, args);
    if (Array.isArray(state?.tabs)) state.tabs = state.tabs.filter((t: any) => t.type !== TAB_TYPE);
    return state;
  };
  pane.__zbrOrigGetState = orig;
  pane.__zbrGetState = wrapper;
  pane.getState = wrapper;
}

export function unpatchTabs(win: any) {
  const Tabs = win.Zotero_Tabs;
  const ids = Tabs?._tabs.filter((t: any) => t.type === TAB_TYPE).map((t: any) => t.id) ?? [];
  if (ids.length) Tabs.close(ids);
  const pane = win.ZoteroPane;
  if (!pane?.__zbrOrigGetState) return;
  // Restore only if nobody wrapped getState after us; otherwise leave their wrapper intact.
  if (pane.getState === pane.__zbrGetState) pane.getState = pane.__zbrOrigGetState;
  delete pane.__zbrOrigGetState;
  delete pane.__zbrGetState;
}
