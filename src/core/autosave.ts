import type { PixelDocument } from './document';
import { keysOf, SELECTION_KEY, serialiseProject } from './project-format';
import type { ProjectRecord, ProjectStore } from './project-store';

export const AUTOSAVE_INTERVAL_MS = 90_000;

/** Signature canvas size. Small enough to hash instantly, big enough to notice edits. */
const SIGNATURE_EDGE = 40;

export interface AutosaveDeps {
  readonly doc: PixelDocument;
  readonly store: ProjectStore;
  readonly projectId: () => string;
  readonly viewport: () => { zoom: number; panX: number; panY: number };
  readonly composite: () => HTMLCanvasElement;
  readonly onSaved?: (record: ProjectRecord) => void;
  readonly onError?: (message: string) => void;
}

const signatureCanvas = document.createElement('canvas');
signatureCanvas.width = SIGNATURE_EDGE;
signatureCanvas.height = SIGNATURE_EDGE;

/**
 * A cheap content fingerprint.
 *
 * Re-encoding every layer to PNG on each autosave is what would make saving
 * visible, so a layer is only rewritten when this changes. Downsampling first
 * keeps the hash to a few thousand bytes whatever the layer's real size.
 */
export function bitmapSignature(canvas: HTMLCanvasElement): string {
  const ctx = signatureCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return `${canvas.width}x${canvas.height}`;

  ctx.clearRect(0, 0, SIGNATURE_EDGE, SIGNATURE_EDGE);
  ctx.drawImage(canvas, 0, 0, SIGNATURE_EDGE, SIGNATURE_EDGE);

  const data = ctx.getImageData(0, 0, SIGNATURE_EDGE, SIGNATURE_EDGE).data;
  let hash = 2166136261;
  for (let i = 0; i < data.length; i++) {
    hash ^= data[i]!;
    hash = Math.imul(hash, 16777619);
  }
  return `${canvas.width}x${canvas.height}:${(hash >>> 0).toString(36)}`;
}

async function thumbnailOf(composite: HTMLCanvasElement): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 160 / Math.max(1, composite.width, composite.height));
  canvas.width = Math.max(1, Math.round(composite.width * scale));
  canvas.height = Math.max(1, Math.round(composite.height * scale));
  canvas.getContext('2d')?.drawImage(composite, 0, 0, canvas.width, canvas.height);

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

export async function buildRecord(
  deps: AutosaveDeps,
  id: string,
  reuse?: { blobs: Record<string, Blob>; keys: ReadonlySet<string> },
): Promise<ProjectRecord> {
  const { document: stored, blobs } = await serialiseProject(deps.doc, {
    viewport: deps.viewport(),
    reuse: reuse?.keys,
  });

  // Carry forward anything that did not need re-encoding.
  const merged: Record<string, Blob> = {};
  const needed = keysOf(stored);
  if (reuse) {
    for (const [key, blob] of Object.entries(reuse.blobs)) {
      if (needed.has(key)) merged[key] = blob;
    }
  }
  for (const [key, blob] of blobs) merged[key] = blob;

  let bytes = 0;
  for (const blob of Object.values(merged)) bytes += blob.size;

  return {
    id,
    name: deps.doc.name,
    updated: Date.now(),
    bytes,
    thumbnail: await thumbnailOf(deps.composite()),
    document: stored,
    blobs: merged,
  };
}

/**
 * Autosaves into a per-document recovery slot, every 90 seconds and whenever
 * the tab is hidden, which is the last moment before a tab is closed or
 * discarded.
 */
export class Autosave {
  private readonly deps: AutosaveDeps;
  private timer = 0;
  private running = false;
  private signatures = new Map<string, string>();
  private lastRecord: ProjectRecord | null = null;
  /** Selections are immutable, so identity is enough to know it is unchanged. */
  private lastSelection: unknown = null;
  private readonly detach: () => void;

  constructor(deps: AutosaveDeps) {
    this.deps = deps;

    const onHidden = (): void => {
      if (document.visibilityState === 'hidden') void this.run();
    };
    document.addEventListener('visibilitychange', onHidden);
    this.detach = () => document.removeEventListener('visibilitychange', onHidden);

    this.timer = window.setInterval(() => void this.run(), AUTOSAVE_INTERVAL_MS);
  }

  destroy(): void {
    window.clearInterval(this.timer);
    this.detach();
  }

  /** Layers whose bitmaps still match the last autosave. */
  private unchangedKeys(): Set<string> {
    const unchanged = new Set<string>();
    if (!this.lastRecord) return unchanged;

    const stored = new Map(this.lastRecord.document.layers.map((l) => [l.id, l]));
    for (const layer of this.deps.doc.layers) {
      const record = stored.get(layer.id);
      if (!record) continue;

      if (record.bitmapKey) {
        const signature = bitmapSignature(layer.canvas);
        if (this.signatures.get(record.bitmapKey) === signature) unchanged.add(record.bitmapKey);
      }
      if (record.maskKey && layer.mask) {
        const signature = bitmapSignature(layer.mask);
        if (this.signatures.get(record.maskKey) === signature) unchanged.add(record.maskKey);
      }
    }

    if (this.deps.doc.selection !== null && this.deps.doc.selection === this.lastSelection) {
      unchanged.add(SELECTION_KEY);
    }
    return unchanged;
  }

  private rememberSignatures(record: ProjectRecord): void {
    const next = new Map<string, string>();
    const stored = new Map(record.document.layers.map((l) => [l.id, l]));

    for (const layer of this.deps.doc.layers) {
      const entry = stored.get(layer.id);
      if (!entry) continue;
      if (entry.bitmapKey) next.set(entry.bitmapKey, bitmapSignature(layer.canvas));
      if (entry.maskKey && layer.mask) next.set(entry.maskKey, bitmapSignature(layer.mask));
    }
    this.signatures = next;
    this.lastSelection = this.deps.doc.selection;
  }

  /** Writes a recovery snapshot. Overlapping calls are ignored, not queued. */
  async run(): Promise<ProjectRecord | null> {
    if (this.running) return null;
    this.running = true;

    try {
      const id = this.deps.projectId();
      const reuse = this.lastRecord
        ? { blobs: this.lastRecord.blobs, keys: this.unchangedKeys() }
        : undefined;

      const record = await buildRecord(this.deps, id, reuse);
      await this.deps.store.saveRecovery(record);

      this.lastRecord = record;
      this.rememberSignatures(record);
      this.deps.onSaved?.(record);
      return record;
    } catch (error) {
      this.deps.onError?.(
        error instanceof Error ? error.message : 'The automatic save did not complete.',
      );
      return null;
    } finally {
      this.running = false;
    }
  }

  /** Called after an explicit save, so the next autosave reuses its blobs. */
  adopt(record: ProjectRecord): void {
    this.lastRecord = record;
    this.rememberSignatures(record);
  }
}
