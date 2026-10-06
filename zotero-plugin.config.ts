import { defineConfig } from "zotero-plugin-scaffold";
import path from "node:path";
import pkg from "./package.json";

const buildEnv =
  process.env.NODE_ENV === "development" ? "development" : "production";

export default defineConfig({
  source: ["src", "core", "reader", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  updateURL: `${pkg.homepage}/releases/download/release/update.json`,
  xpiDownloadLink: "",

  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: { __env__: JSON.stringify(buildEnv) },
        bundle: true,
        target: "firefox115",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
      {
        entryPoints: ["reader/main.ts"],
        define: { __env__: JSON.stringify(buildEnv) },
        bundle: true,
        format: "iife",
        target: "firefox115",
        outfile: ".scaffold/build/addon/content/reader/reader.js",
      },
    ],
  },

  server: {
    // The browser toolbox window is noise during automated runs; open it by hand when debugging.
    devtools: false,
  },

  test: {
    entries: ["test/zotero"],
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}?.initialized`,
    watch: false,
    mocha: { timeout: 240_000 },
    // Paths the in-Zotero tests read fixtures from and write screenshots to.
    prefs: {
      [`${pkg.config.prefsPrefix}.test.root`]: path.resolve("."),
      [`${pkg.config.prefsPrefix}.test.pdf`]: process.env.ZBR_TEST_PDF ?? path.join(process.env.USERPROFILE ?? "", "Zotero/storage/4LW4ETNL/Zhang et al_2021_Multi-Source and Temporal Attention Network for Probabilistic Wind Power Predict.pdf"),
      [`${pkg.config.prefsPrefix}.test.live`]: process.env.ZBR_TEST_LIVE === "1",
      // Optional: a second PDF (with its MinerU folder and translation cache) for the scroll diagnostic.
      [`${pkg.config.prefsPrefix}.test.perfPdf`]: process.env.ZBR_PERF_PDF ?? "",
      [`${pkg.config.prefsPrefix}.test.perfMineru`]: process.env.ZBR_PERF_MINERU ?? "",
      [`${pkg.config.prefsPrefix}.test.perfCache`]: process.env.ZBR_PERF_CACHE ?? "",
    },
  },
});
