import { config } from "../package.json";
import { isPrefetching, prefetch, stopPrefetch } from "./zotero/prefetch";
import { onPrefsLoad } from "./zotero/prefs-pane";
import { canOpen, closeOverlays, openBilingual, patchTabs, unpatchTabs } from "./zotero/tab";

const pluginID = config.addonID;
const Z = Zotero as any;
const addon = () => Z[config.addonInstance];

const ICON = `chrome://${config.addonRef}/content/icons/bilingual.svg`;
let menuID: string | false = false;

function registerMenu() {
  menuID = Z.MenuManager.registerMenu({
    menuID: `${config.addonRef}-open`,
    pluginID,
    target: "main/library/item",
    menus: [
      {
        menuType: "menuitem",
        l10nID: `${config.addonRef}-menu-open-bilingual`,
        icon: ICON,
        onShowing: (_ev: Event, ctx: any) => ctx.setVisible(ctx.items?.length === 1 && canOpen(ctx.items[0])),
        onCommand: (_ev: Event, ctx: any) => void openBilingual(ctx.items[0]),
      },
      {
        // Translate the selected papers in the background, without opening them.
        menuType: "menuitem",
        l10nID: `${config.addonRef}-menu-prefetch`,
        onShowing: (_ev: Event, ctx: any) => ctx.setVisible(!!ctx.items?.some((it: any) => canOpen(it))),
        onCommand: (_ev: Event, ctx: any) => void prefetch(ctx.items.filter((it: any) => canOpen(it))),
      },
      {
        menuType: "menuitem",
        l10nID: `${config.addonRef}-menu-prefetch-stop`,
        onShowing: (_ev: Event, ctx: any) => ctx.setVisible(isPrefetching()),
        onCommand: () => stopPrefetch(),
      },
    ],
  });
}

// Two facing pages, "A" on the left and "文" on the right: same 20 px box as Zotero's own icons.
const TOOLBAR_SVG = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.25" aria-hidden="true"><path d="M2 4.5h6.2c.9 0 1.8.7 1.8 1.6V17c0-.8-.8-1.5-1.8-1.5H2z"/><path d="M18 4.5h-6.2c-.9 0-1.8.7-1.8 1.6V17c0-.8.8-1.5 1.8-1.5H18z"/><text x="3.4" y="12.6" font-size="6.6" font-weight="700" font-family="Arial, sans-serif" fill="currentColor" stroke="none">A</text><text x="11.1" y="12.9" font-size="6.4" font-family="sans-serif" fill="currentColor" stroke="none">文</text></svg>`;

function makeToolbarButton(doc: Document, itemID: number): HTMLElement {
  const btn = doc.createElement("button");
  btn.className = "toolbar-button";
  btn.title = "双语阅读";
  btn.setAttribute("aria-label", "双语阅读");
  btn.dataset.zbr = "open";
  btn.tabIndex = -1;
  btn.innerHTML = TOOLBAR_SVG;
  btn.addEventListener("click", () => void openBilingual(Zotero.Items.get(itemID)));
  return btn;
}

function onRenderToolbar(event: any) {
  const { reader, doc, append } = event;
  if (reader.type && reader.type !== "pdf") return;
  append(makeToolbarButton(doc, reader.itemID));
}

/** Readers opened before the plugin started never fire renderToolbar again; add the button there too. */
function decorateOpenReaders() {
  for (const reader of Z.Reader._readers ?? []) {
    try {
      if (reader.type && reader.type !== "pdf") continue;
      const doc = reader._iframeWindow?.document;
      const box = doc?.querySelector(".toolbar .custom-sections") ?? doc?.querySelector(".custom-sections");
      if (!box || box.querySelector("[data-zbr]")) continue;
      box.append(makeToolbarButton(doc, reader.itemID));
    } catch (e) {
      Zotero.logError(e as Error);
    }
  }
}

function removeToolbarButtons() {
  for (const reader of Z.Reader._readers ?? []) {
    reader._iframeWindow?.document?.querySelectorAll("[data-zbr]").forEach((b: Element) => b.remove());
  }
}

async function onStartup() {
  await Promise.all([Zotero.initializationPromise, Zotero.unlockPromise, Zotero.uiReadyPromise]);
  registerMenu();
  Z.Reader.registerEventListener("renderToolbar", onRenderToolbar, pluginID);
  decorateOpenReaders();
  addon().prefPaneID = await Z.PreferencePanes.register({
    pluginID,
    src: `${addon().rootURI}content/preferences.xhtml`,
    label: "双语阅读",
    image: `chrome://${config.addonRef}/content/icons/favicon.png`,
  });
  await Promise.all(Zotero.getMainWindows().map((win: any) => onMainWindowLoad(win)));
  addon().initialized = true;
}

async function onMainWindowLoad(win: any) {
  win.MozXULElement.insertFTLIfNeeded(`${config.addonRef}-mainWindow.ftl`);
  patchTabs(win);
}

async function onMainWindowUnload(win: any) {
  closeOverlays();
  unpatchTabs(win);
}

async function onShutdown() {
  closeOverlays();
  for (const win of Zotero.getMainWindows()) unpatchTabs(win);
  if (menuID) Z.MenuManager.unregisterMenu(menuID);
  Z.Reader.unregisterEventListener("renderToolbar", onRenderToolbar);
  removeToolbarButtons();
  addon().initialized = false;
  delete Z[config.addonInstance];
}

export const hooks = { onStartup, onShutdown, onMainWindowLoad, onMainWindowUnload, onPrefsLoad };
