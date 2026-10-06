// Subset of zotero/structured-document-text schema.d.ts that ZBR reads.

export type RefPath = number[];
export type PageRect = [number, number, number, number, number]; // pageIndex, x1, y1, x2, y2

export interface SdtAnchor {
  pageRects?: PageRect[];
  textMap?: string;
}

export interface SdtTextStyle {
  bold?: boolean;
  italic?: boolean;
  sub?: boolean;
  sup?: boolean;
  monospace?: boolean;
}

export interface SdtTextNode {
  text: string;
  style?: SdtTextStyle;
  refs?: RefPath[];
  anchor?: SdtAnchor;
  type?: undefined;
}

export interface SdtBlockNode {
  type: string;
  content?: (SdtBlockNode | SdtTextNode)[];
  anchor?: SdtAnchor;
  reference?: boolean;
  ordered?: boolean;
  startIndex?: number;
  previousPart?: RefPath;
  nextPart?: RefPath;
  flowClass?: "auxiliary" | "excluded";
}

export interface SdtOutlineItem {
  title: string;
  ref?: RefPath;
  children?: SdtOutlineItem[];
}

export interface SdtDocument {
  schemaVersion: string;
  metadata: {
    processor: { type: string; version: number };
    dateCreated?: string;
    source: { contentType: string; hash: string };
  };
  catalog: {
    outline?: SdtOutlineItem[];
    pages: { viewRect?: number[]; label?: string; contentRange: [RefPath, RefPath] }[];
  };
  content: SdtBlockNode[];
}

export function isTextNode(n: SdtBlockNode | SdtTextNode): n is SdtTextNode {
  return typeof (n as SdtTextNode).text === "string" && !(n as SdtBlockNode).type;
}
