// Contract between the reader front-end and its host (Zotero plugin, or the dev mock).

import type { Enrichment } from "./mineru";
import type { ZbrDocument } from "./model";

export type Mode = "en" | "interleave" | "zh" | "side";
export type Granularity = 1 | 2 | 3 | "para";
export type PeekStyle = "off" | "popover" | "inline" | "swap";
/** Display math and tables: cropped from the PDF, or rebuilt from MinerU (LaTeX via KaTeX, HTML tables). */
export type RichStyle = "pdf" | "mineru";
/** Where the document text comes from: Zotero's structured text, or a MinerU parse of the PDF. */
export type DocSource = "zotero" | "mineru";
/** Page colours: follow Zotero's light/dark setting, or a fixed light, sepia or dark theme. */
export type Theme = "auto" | "light" | "sepia" | "dark";
/** How the sentence pair under the mouse is marked: a frame, a fill or an underline. */
export type PairStyle = "frame" | "fill" | "underline";

export interface UnitTranslation {
  zh: string;
  /** Hash of the English source sentence the translation was made from. */
  srcHash: string;
}

export interface TranslationProgress {
  running: boolean;
  done: number;
  total: number;
  failed: number;
  engineLabel?: string;
  message?: string;
}

export interface ReaderPrefs {
  mode: Mode;
  granularity: Granularity;
  fontSize: number;
  /**
   * How the other language is revealed in single-language modes (en / zh):
   * off, a floating bubble on hover, an expanded box under the paragraph on hover,
   * or click-to-swap the sentence group in place.
   */
  peek: PeekStyle;
  rich: RichStyle;
  /** Translate automatically as blocks scroll into view. */
  autoTranslate: boolean;
  engineId: string;
  /** Put the Chinese translation into the comment of highlights created here, so notes built from annotations carry both languages. */
  highlightWithZh: boolean;
  source: DocSource;
  theme: Theme;
  pairStyle: PairStyle;
  /** CSS colour of the pair mark; empty follows the theme. */
  pairColor: string;
  /** Side panel with the paper's headings and bookmarks: open, and which tab. */
  outline: boolean;
  outlineTab: "toc" | "marks" | "notes";
}

/** A place in the paper the reader marked. */
export interface Bookmark {
  blockId: string;
  /** Start of the block's text: finds the place again in the other source (other block ids). */
  text: string;
  page?: number;
  t: number;
}

export const DEFAULT_PREFS: ReaderPrefs = {
  mode: "interleave",
  granularity: 1,
  fontSize: 17,
  peek: "popover",
  rich: "mineru",
  // Translation costs quota: it starts when the reader asks for it (toolbar, paragraph button).
  autoTranslate: false,
  engineId: "",
  highlightWithZh: true,
  source: "zotero",
  theme: "auto",
  pairStyle: "frame",
  pairColor: "",
  outline: false,
  outlineTab: "toc",
};

export interface EngineInfo {
  id: string;
  label: string;
  kind: "api" | "agent" | "mock";
  ready: boolean;
  note?: string;
}

export interface HighlightView {
  id: string;
  color: string;
  /** Sentences (unit ids) covered by the annotation. */
  unitIds: string[];
  text?: string;
  comment?: string;
}

export interface HandoffInfo {
  dir: string;
  /** Paste into any agent session. */
  prompt: string;
  /** Ready-to-run PowerShell lines per agent CLI. */
  commands: { tool: string; line: string }[];
  todo: number;
  /** Sentences delivered that passed the checks. */
  delivered: number;
  /** Delivered but unusable, with the reason. */
  bad: number;
  phase: "waiting" | "glossary" | "translating" | "checking" | "done";
  /** Epoch ms of the agent's last file write in the folder, if any. */
  lastWrite?: number;
  startedAt: number;
  watching: boolean;
  /** Prompt of the current fix task, if one was made. */
  fixPrompt?: string;
}

export type HostEvent =
  | { type: "handoff"; handoff: HandoffInfo }
  | { type: "translations"; units: Record<string, UnitTranslation>; failed?: Record<string, string> }
  | { type: "progress"; progress: TranslationProgress }
  | { type: "highlights"; highlights: HighlightView[] };

export interface ZbrHost {
  getDocument(): Promise<ZbrDocument>;
  getTranslations(): Promise<Record<string, UnitTranslation>>;
  subscribe(cb: (ev: HostEvent) => void): () => void;
  /** Request translation of blocks (in priority order). Already translated units are skipped. */
  translate(req: {
    blockIds?: string[];
    all?: boolean;
    retryFailed?: boolean;
    /** Translate again with the current engine even where a cached translation exists. */
    retranslate?: boolean;
  }): Promise<void>;
  cancel(): Promise<void>;
  /** Replace one sentence's translation with the reader's own wording (kept until retranslated). */
  editTranslation(unitId: string, zh: string): Promise<void>;
  /** Forget every cached translation of this paper (Zotero and MinerU text alike). */
  /** Drop cached translations: of the source on screen, or of both sources ("all", default). */
  clearTranslations(scope?: "source" | "all"): Promise<void>;

  /** Key terms used by batch translation of this paper (English = 中文 lines); null until made. */
  getPaperGlossary(): Promise<string | null>;
  setPaperGlossary(text: string): Promise<void>;

  /**
   * Whole-paper translation by an agent the reader runs and watches: write a task folder for the
   * untranslated sentences (or reuse the open one) and watch it for results.
   */
  startHandoff(opts?: { fresh?: boolean }): Promise<HandoffInfo>;
  getHandoff(): Promise<HandoffInfo | null>;
  /** Write a fix task for sentences that are missing or failed the checks; returns its prompt. */
  handoffFix(): Promise<string | null>;
  /** Stop watching the folder (the folder and imported translations stay). */
  stopHandoff(): Promise<void>;
  openHandoffFile(which: "folder" | "report"): Promise<void>;
  getEngines(): Promise<EngineInfo[]>;

  getPdfData(): Promise<Uint8Array>;
  /** MinerU enrichment keyed by block id, or null when the paper has no MinerU parse. Read-only. */
  getEnrichment(): Promise<Record<string, Enrichment> | null>;
  /** Whether a MinerU parse of this exact PDF exists, i.e. the "MinerU" source can be chosen. */
  hasMineru(): Promise<boolean>;
  pdfjs: { lib: string; worker: string };

  openInPdf(target: { blockId: string; unitIds?: string[] }): Promise<void>;
  getHighlights(): Promise<HighlightView[]>;
  createHighlight(req: { unitIds: string[]; color: string; comment?: string }): Promise<void>;
  /** Change the comment or color of a highlight (any annotation of this PDF). */
  updateHighlight(req: { id: string; comment?: string; color?: string }): Promise<void>;
  deleteHighlight(id: string): Promise<void>;
  /** Open the PDF with the annotation selected in Zotero's reader (and its sidebar). */
  openHighlight(id: string): Promise<void>;

  /** Block the reader was last looking at in this paper, kept with the translation cache. */
  getPosition(): Promise<string | null>;
  setPosition(blockId: string): Promise<void>;
  /** Bookmarks of this paper, kept with the translation cache. */
  getBookmarks(): Promise<Bookmark[]>;
  setBookmarks(list: Bookmark[]): Promise<void>;

  getPrefs(): Promise<ReaderPrefs>;
  setPrefs(p: Partial<ReaderPrefs>): Promise<void>;
  /** Host capabilities so the UI can hide unsupported actions. */
  capabilities: { openInPdf: boolean; highlights: boolean };
  /**
   * Parse this PDF with MinerU (cloud API, user's token) so the "MinerU" source and typeset
   * formulas become available. Progress arrives as progress messages. Absent where unsupported.
   */
  parseMineru?(): Promise<void>;
  /** Whether a MinerU API token is set (so parseMineru can run without asking for one first). */
  mineruReady?(): Promise<boolean>;
  /** Save the MinerU API token (same as the field in the plugin settings). */
  setMineruToken?(token: string): Promise<void>;
  /** Open a web page in the user's browser. */
  openUrl?(url: string): void;
  /** Move this page from its tab to a window of its own (only where that applies). */
  popOut?(): Promise<void>;
}

declare global {
  interface Window {
    zbrHost?: ZbrHost;
  }
}
