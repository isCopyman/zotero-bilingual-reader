import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Tests that read a real paper need test/fixtures/zhang2021.*.json, which is not published
// (the paper's text is copyrighted). Without it only the self-contained tests run.
const paperTests = ["align", "build", "locate", "mineru-doc", "mineru", "protocol", "whole"].map((n) => `test/unit/${n}.test.ts`);
const hasPaper = existsSync("test/fixtures/zhang2021.sdt.json");

export default defineConfig({ test: { include: ["test/unit/**/*.test.ts"], exclude: hasPaper ? [] : paperTests } });
