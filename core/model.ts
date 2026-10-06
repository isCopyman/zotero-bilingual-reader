// ZBR document model: renderer- and engine-independent.

import type { SdtTextStyle } from "./sdt-types";

export type BlockKind =
  | "heading"
  | "paragraph"
  | "listitem"
  | "caption"
  | "math"
  | "image"
  | "table"
  | "pre";

/** A run of source text inside a block's logical text. Offsets are UTF-16. */
export interface TextSegment {
  /** Path of the SDT text node: block refPath + node index. */
  nodePath: number[];
  /** Start offset of this segment in the block's logical text. */
  start: number;
  /** Offset inside the node text where the segment begins (non-zero for drop-cap merges). */
  nodeStart: number;
  length: number;
  style?: SdtTextStyle;
}

export interface Sentence {
  /** Stable within a document version: `${blockId}:${index}`. */
  id: string;
  /** [start, end) in the block's logical text. */
  start: number;
  end: number;
  text: string;
  /** Hash of the sentence text; used to re-anchor translations and as cache key input. */
  hash: string;
}

export interface Block {
  id: string;
  kind: BlockKind;
  /** refPaths of all SDT parts that make up this logical block (part chains). */
  parts: number[][];
  /** Heading depth (1-based), when kind === "heading". */
  level?: number;
  text: string;
  segments: TextSegment[];
  sentences: Sentence[];
  /** Page rects of the block: [pageIndex, x1, y1, x2, y2]. */
  pageRects: [number, number, number, number, number][];
  /** Whether the block should be sent for translation. */
  translatable: boolean;
  /** Reference list entries, captions etc. */
  role?: "reference" | "caption" | "footnote";
  /** Content taken from a MinerU parse: LaTeX of a display equation, HTML of a table. */
  mineru?: { latex?: string; tableHtml?: string };
  /** Text contains inline LaTeX as `$...$` (MinerU source), rendered with KaTeX. */
  inlineMath?: boolean;
}

export interface ZbrDocument {
  /** attachmentKey|pdfHash|parser version */
  docId: string;
  pdfHash: string;
  parser: { kind: "sdt" | "mineru"; version: number; schema: string };
  title?: string;
  pages: { width: number; height: number; label?: string }[];
  blocks: Block[];
}
