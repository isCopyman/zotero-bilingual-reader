import { config } from "../package.json";
import { runBatch } from "../core/translate/runner";
import { hooks } from "./hooks";
import { getEngine, listEngines, registerEngine, unregisterEngine } from "./zotero/engines";
import { cacheDir } from "./zotero/store";
import { isPrefetching, prefetch, stopPrefetch } from "./zotero/prefetch";
import { openBilingual, TAB_TYPE } from "./zotero/tab";

const Z = Zotero as any;
if (!Z[config.addonInstance]) {
  Z[config.addonInstance] = {
    initialized: false,
    rootURI: (_globalThis as any).rootURI as string,
    hooks,
    // Entry points for other plugins, scripts and the integration tests.
    api: { openBilingual, listEngines, getEngine, registerEngine, unregisterEngine, runBatch, cacheDir, TAB_TYPE, prefetch, isPrefetching, stopPrefetch },
  };
}
