// Opens the bilingual reader in a Zotero tab: a chrome iframe hosting reader/index.html, with the
// host object injected into its window.

import { config } from "../../package.json";
import { createHost, type ZoteroHost } from "./host";

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

export async function openBilingual(item: any) {
  const attachment = await resolveAttachment(item);
  const win = Zotero.getMainWindow() as any;
  if (!attachment) {
    win.alert("没有找到可用的 PDF 附件。");
    return;
  }
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
    data: { zbrItemID: attachment.id },
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
  const doc = win.document as Document;
  const iframe = doc.createElementNS("http://www.w3.org/1999/xhtml", "iframe") as HTMLIFrameElement;
  iframe.setAttribute("src", READER_URL);
  iframe.setAttribute("flex", "1");
  iframe.style.cssText = "border:0;width:100%;height:100%;display:block;";
  (container as HTMLElement).style.display = "flex";
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
  container.append(iframe);
}

const windows = new Map<number, Window>();

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
 */
export function patchTabs(win: any) {
  const Tabs = win.Zotero_Tabs;
  if (!Tabs || Tabs.__zbrOrigGetState) return;
  const orig = Tabs.getState;
  const wrapper = function (this: any, ...args: any[]) {
    return orig.apply(this, args).filter((t: any) => t.type !== TAB_TYPE);
  };
  Tabs.__zbrOrigGetState = orig;
  Tabs.__zbrGetState = wrapper;
  Tabs.getState = wrapper;
}

export function unpatchTabs(win: any) {
  const Tabs = win.Zotero_Tabs;
  if (!Tabs?.__zbrOrigGetState) return;
  const ids = Tabs._tabs.filter((t: any) => t.type === TAB_TYPE).map((t: any) => t.id);
  if (ids.length) Tabs.close(ids);
  // Restore only if nobody wrapped getState after us; otherwise leave their wrapper intact.
  if (Tabs.getState === Tabs.__zbrGetState) Tabs.getState = Tabs.__zbrOrigGetState;
  delete Tabs.__zbrOrigGetState;
  delete Tabs.__zbrGetState;
}
