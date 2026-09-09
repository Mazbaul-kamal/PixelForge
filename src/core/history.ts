import type { PixelDocument } from './document';
import type { Layer } from './types';
import {
  captureDocument,
  captureLayerPixels,
  documentSnapshotsEqual,
  restoreDocument,
  restoreLayerPixels,
} from './snapshot';

export const HISTORY_LIMIT = 50;

interface HistoryEntry {
  readonly label: string;
  readonly undo: () => void;
  readonly redo: () => void;
}

/** An open edit. Commit pushes one entry; nothing is pushed if nothing changed. */
export interface Transaction {
  readonly label: string;
  readonly isOpen: boolean;
  commit(): boolean;
  cancel(): void;
}

/**
 * Command-based undo/redo. Every user-visible change goes through here.
 *
 * Entries come in two kinds so that large documents stay affordable:
 * pixel entries clone one layer's bitmap, structural entries snapshot the
 * layer list and properties while holding bitmaps by reference.
 */
export class History {
  private readonly doc: PixelDocument;
  private readonly entries: HistoryEntry[] = [];
  private readonly listeners = new Set<() => void>();

  /** Number of entries applied. 0 is the base state, so it is also the cursor. */
  private cursor = 0;
  private base: string;
  /** Bumped whenever the entry list itself changes, so the panel can rebuild. */
  private listVersion = 0;
  private applying = false;
  private open: OpenTransaction | null = null;

  constructor(doc: PixelDocument, baseLabel = 'Initial state') {
    this.doc = doc;
    this.base = baseLabel;
  }

  get index(): number {
    return this.cursor;
  }

  get baseLabel(): string {
    return this.base;
  }

  get entryLabels(): readonly string[] {
    return this.entries.map((entry) => entry.label);
  }

  get version(): number {
    return this.listVersion;
  }

  get canUndo(): boolean {
    return this.cursor > 0;
  }

  get canRedo(): boolean {
    return this.cursor < this.entries.length;
  }

  get openTransaction(): Transaction | null {
    return this.open;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Records an already-performed change. Truncates any redo tail. */
  push(label: string, undo: () => void, redo: () => void): void {
    if (this.applying) return;

    if (this.entries.length > this.cursor) this.entries.length = this.cursor;
    this.entries.push({ label, undo, redo });

    if (this.entries.length > HISTORY_LIMIT) {
      const dropped = this.entries.shift();
      // The state after the dropped entry is the new base state.
      if (dropped) this.base = dropped.label;
    } else {
      this.cursor += 1;
    }

    this.listVersion += 1;
    this.notify();
  }

  undo(): boolean {
    if (!this.canUndo || this.applying) return false;
    const entry = this.entries[this.cursor - 1];
    if (!entry) return false;

    this.apply(entry.undo);
    this.cursor -= 1;
    this.notify();
    return true;
  }

  redo(): boolean {
    if (!this.canRedo || this.applying) return false;
    const entry = this.entries[this.cursor];
    if (!entry) return false;

    this.apply(entry.redo);
    this.cursor += 1;
    this.notify();
    return true;
  }

  /** Walks to `target` (0 is the base state) one entry at a time. */
  jumpTo(target: number): boolean {
    if (this.applying) return false;
    const clamped = Math.min(Math.max(Math.round(target), 0), this.entries.length);
    if (clamped === this.cursor) return false;

    while (this.cursor > clamped) {
      const entry = this.entries[this.cursor - 1];
      if (!entry) break;
      this.apply(entry.undo);
      this.cursor -= 1;
    }
    while (this.cursor < clamped) {
      const entry = this.entries[this.cursor];
      if (!entry) break;
      this.apply(entry.redo);
      this.cursor += 1;
    }

    this.notify();
    return true;
  }

  clear(baseLabel = this.base): void {
    this.open?.cancel();
    this.entries.length = 0;
    this.cursor = 0;
    this.base = baseLabel;
    this.listVersion += 1;
    this.notify();
  }

  /**
   * Opens a structural edit. Hold the handle across a continuous interaction
   * (a slider drag) and commit once, so the whole drag is a single entry.
   */
  beginStructural(label: string): Transaction {
    return this.begin(label, () => {
      const before = captureDocument(this.doc);
      return {
        finish: () => {
          const after = captureDocument(this.doc);
          if (documentSnapshotsEqual(before, after)) return null;
          return {
            undo: () => restoreDocument(this.doc, before),
            redo: () => restoreDocument(this.doc, after),
          };
        },
        revert: () => restoreDocument(this.doc, before),
      };
    });
  }

  /** Opens an edit confined to one layer's bitmap. */
  beginPixel(label: string, layer: Layer): Transaction {
    return this.begin(label, () => {
      const before = captureLayerPixels(layer);
      return {
        finish: () => {
          const after = captureLayerPixels(layer);
          return {
            undo: () => restoreLayerPixels(this.doc, before),
            redo: () => restoreLayerPixels(this.doc, after),
          };
        },
        revert: () => restoreLayerPixels(this.doc, before),
      };
    });
  }

  /** Runs a multi-step structural change as one undo entry. */
  transaction(label: string, fn: () => void): boolean {
    const tx = this.beginStructural(label);
    try {
      fn();
    } catch (error) {
      tx.cancel();
      throw error;
    }
    return tx.commit();
  }

  /** Runs a multi-step bitmap change on one layer as one undo entry. */
  pixelTransaction(label: string, layer: Layer, fn: () => void): boolean {
    const tx = this.beginPixel(label, layer);
    try {
      fn();
    } catch (error) {
      tx.cancel();
      throw error;
    }
    return tx.commit();
  }

  private begin(label: string, capture: () => CaptureHandle): Transaction {
    // Never silently drop an edit: an unfinished transaction is committed
    // rather than abandoned when a new one starts.
    this.open?.commit();
    const transaction = new OpenTransaction(this, label, capture());
    this.open = transaction;
    return transaction;
  }

  /** @internal Used by OpenTransaction when it settles. */
  closeTransaction(transaction: OpenTransaction): void {
    if (this.open === transaction) this.open = null;
  }

  private apply(action: () => void): void {
    this.applying = true;
    try {
      action();
    } finally {
      this.applying = false;
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

interface CaptureHandle {
  finish: () => { undo: () => void; redo: () => void } | null;
  revert: () => void;
}

class OpenTransaction implements Transaction {
  readonly label: string;
  private readonly history: History;
  private readonly handle: CaptureHandle;
  private settled = false;

  constructor(history: History, label: string, handle: CaptureHandle) {
    this.history = history;
    this.label = label;
    this.handle = handle;
  }

  get isOpen(): boolean {
    return !this.settled;
  }

  commit(): boolean {
    if (this.settled) return false;
    this.settled = true;
    this.history.closeTransaction(this);

    const result = this.handle.finish();
    if (!result) return false;

    this.history.push(this.label, result.undo, result.redo);
    return true;
  }

  cancel(): void {
    if (this.settled) return;
    this.settled = true;
    this.history.closeTransaction(this);
    this.handle.revert();
  }
}
