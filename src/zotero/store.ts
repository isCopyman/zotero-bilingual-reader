// Translation cache: one JSON file per attachment under <Zotero data dir>/zotero-bilingual-reader/.
// Keyed by the English source sentence hash, so re-segmentation or a new SDT version keeps every
// translation whose source text is unchanged. Never written into the Zotero library itself.
//
// Policy: a cached translation is reused whatever engine produced it; each entry records the
// engine configuration, prompt version and glossary it was made with, and the reader's
// "retranslate" action replaces it with the current engine's output.

import type { Bookmark } from "../../core/host-api";
import { PROMPT_VERSION } from "../../core/translate/protocol";
import { clearTimeout, setTimeout } from "./globals";

export interface CachedUnit {
  zh: string;
  /** Engine configuration key (engine id, model, endpoint) that produced the translation. */
  engine: string;
  prompt: string;
  /** Hash of the glossary in effect, "" when none. */
  glossary: string;
  t: number;
}

interface CacheFile {
  version: 1;
  libraryID: number;
  attachmentKey: string;
  units: Record<string, CachedUnit>;
  /** Block the reader was last looking at. */
  position?: string;
  /** The reader's bookmarks in this paper. */
  bookmarks?: Bookmark[];
  /** Key terms of this paper (English = 中文 lines), made once before batch translation. */
  glossary?: string;
}

export function cacheDir(): string {
  return PathUtils.join(Zotero.DataDirectory.dir, "zotero-bilingual-reader", "translations");
}

export class TranslationStore {
  private data: CacheFile;
  private path: string;
  private timer: number | undefined;
  private writing: Promise<void> = Promise.resolve();
  /** File modification time as of our last read or write; a later one means someone else wrote. */
  private mtime = 0;
  /** Set by clear(): the next write replaces the file instead of merging what is on disk. */
  private replace = false;
  /** Bumped on every change, whoever made it (another host of the same paper, a merge from disk). */
  rev = 0;

  private constructor(path: string, data: CacheFile, mtime: number) {
    this.path = path;
    this.data = data;
    this.mtime = mtime;
  }

  private static async stat(path: string): Promise<number> {
    try {
      return (await IOUtils.stat(path)).lastModified ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Take in what others wrote to the file since we last saw it (the batch CLI, the agent
   * handoff). Missing entries are added and newer ones win; nothing of ours is dropped.
   */
  async refresh(): Promise<boolean> {
    const m = await TranslationStore.stat(this.path);
    if (!m || m <= this.mtime || this.replace) return false;
    try {
      const raw = (await IOUtils.readJSON(this.path)) as CacheFile;
      if (raw?.version !== 1 || !raw.units) return false;
      let changed = false;
      for (const [h, u] of Object.entries(raw.units)) {
        const mine = this.data.units[h];
        if (!mine || (u.t ?? 0) > (mine.t ?? 0)) {
          this.data.units[h] = u;
          changed = true;
        }
      }
      if (this.data.glossary === undefined && raw.glossary !== undefined) {
        this.data.glossary = raw.glossary;
        changed = true;
      }
      if (this.data.position === undefined && raw.position) this.data.position = raw.position;
      this.mtime = m;
      if (changed) this.rev++;
      return changed;
    } catch (e) {
      Zotero.logError(e as Error);
      return false;
    }
  }

  static fileName(libraryID: number, attachmentKey: string): string {
    // Item keys are only unique within a library.
    return `${libraryID}-${attachmentKey}.json`;
  }

  /**
   * One store per attachment for the whole session: a reopened tab must see what the previous
   * one wrote even if that write is still pending.
   */
  private static opened = new Map<string, Promise<TranslationStore>>();

  static open(libraryID: number, attachmentKey: string): Promise<TranslationStore> {
    const name = TranslationStore.fileName(libraryID, attachmentKey);
    let p = TranslationStore.opened.get(name);
    if (!p) {
      p = TranslationStore.load(libraryID, attachmentKey);
      TranslationStore.opened.set(name, p);
      p.catch(() => TranslationStore.opened.delete(name));
      return p;
    }
    // Reopening a paper picks up what was written to its file meanwhile.
    return p.then(async (store) => {
      await store.refresh();
      return store;
    });
  }

  private static async load(libraryID: number, attachmentKey: string): Promise<TranslationStore> {
    const dir = cacheDir();
    await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
    const path = PathUtils.join(dir, TranslationStore.fileName(libraryID, attachmentKey));
    let data: CacheFile = { version: 1, libraryID, attachmentKey, units: {} };
    const mtime = await TranslationStore.stat(path);
    try {
      if (mtime) {
        const raw = (await IOUtils.readJSON(path)) as CacheFile;
        if (raw?.version === 1 && raw.units) data = raw;
      }
    } catch (e) {
      Zotero.logError(e as Error);
    }
    return new TranslationStore(path, data, mtime);
  }

  get(hash: string): CachedUnit | undefined {
    return this.data.units[hash];
  }

  put(hash: string, zh: string, engine: string, glossary: string) {
    const g = glossary.trim() ? Zotero.Utilities.Internal.md5(glossary.trim(), false).slice(0, 8) : "";
    this.data.units[hash] = { zh, engine, prompt: PROMPT_VERSION, glossary: g, t: Date.now() };
    this.rev++;
    this.scheduleWrite();
  }

  /** Drop all translations; the reading position stays. */
  clear() {
    this.data.units = {};
    delete this.data.glossary;
    this.replace = true;
    this.rev++;
    this.scheduleWrite();
  }

  /** Drop the translations of these sentences; everything else stays. */
  remove(hashes: Iterable<string>) {
    for (const h of hashes) delete this.data.units[h];
    // Written as is: merging the file back in would restore what was just removed.
    this.replace = true;
    this.rev++;
    this.scheduleWrite();
  }

  get glossary(): string | undefined {
    return this.data.glossary;
  }

  set glossary(text: string | undefined) {
    if (this.data.glossary === text) return;
    this.data.glossary = text;
    this.scheduleWrite();
  }

  get bookmarks(): Bookmark[] {
    return this.data.bookmarks ?? [];
  }

  set bookmarks(list: Bookmark[]) {
    this.data.bookmarks = list;
    this.scheduleWrite();
  }

  get position(): string | undefined {
    return this.data.position;
  }

  set position(blockId: string | undefined) {
    if (this.data.position === blockId) return;
    this.data.position = blockId;
    this.scheduleWrite();
  }

  /** Coalesce bursts of results into one atomic write. */
  private scheduleWrite() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.writing = this.writing.then(() => this.flushNow());
    }, 1500);
  }

  private async flushNow() {
    try {
      // Someone else may have written since we last looked: merge first, so their work survives.
      if (!this.replace) await this.refresh();
      this.replace = false;
      await IOUtils.writeJSON(this.path, this.data, { tmpPath: `${this.path}.tmp` });
      this.mtime = await TranslationStore.stat(this.path);
    } catch (e) {
      Zotero.logError(e as Error);
    }
  }

  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.writing = this.writing.then(() => this.flushNow());
    }
    await this.writing;
  }
}
