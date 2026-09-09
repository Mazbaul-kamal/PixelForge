import type { PixelDocument } from './document';
import type { SelectionMask } from './selection';
import type { BlendMode, Layer, LayerType } from './types';

/**
 * Snapshots for the two history entry kinds.
 *
 * The rule that makes both kinds safe to mix: a layer's canvas OBJECT identity
 * never changes once the layer exists. Pixel restores draw back into the same
 * canvas, so a structural snapshot may hold that canvas by reference and stay
 * correct no matter how many pixel edits happen on top of it.
 */

/** One layer's bitmap, cloned. Used for edits confined to a single layer. */
export interface PixelSnapshot {
  readonly layerId: string;
  readonly width: number;
  readonly height: number;
  readonly bitmap: HTMLCanvasElement;
}

interface LayerRecord {
  readonly id: string;
  readonly name: string;
  /** Held by reference: structural changes never touch the pixels. */
  readonly canvas: HTMLCanvasElement;
  readonly x: number;
  readonly y: number;
  readonly opacity: number;
  readonly blendMode: BlendMode;
  readonly visible: boolean;
  readonly locked: boolean;
  readonly type: LayerType;
  readonly mask: HTMLCanvasElement | undefined;
}

/** The layer list, layer properties and document size. No bitmaps are copied. */
export interface DocumentSnapshot {
  readonly width: number;
  readonly height: number;
  readonly activeLayerId: string | null;
  /** Selection masks are treated as immutable, so a reference is enough. */
  readonly selection: SelectionMask | null;
  readonly layers: readonly LayerRecord[];
}

function cloneCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const copy = document.createElement('canvas');
  copy.width = source.width;
  copy.height = source.height;
  const ctx = copy.getContext('2d');
  if (!ctx) throw new Error('Could not acquire a 2D context to clone a bitmap.');
  if (source.width > 0 && source.height > 0) ctx.drawImage(source, 0, 0);
  return copy;
}

export function captureLayerPixels(layer: Layer): PixelSnapshot {
  return {
    layerId: layer.id,
    width: layer.canvas.width,
    height: layer.canvas.height,
    bitmap: cloneCanvas(layer.canvas),
  };
}

/** Restores bitmap contents into the layer's existing canvas object. */
export function restoreLayerPixels(doc: PixelDocument, snapshot: PixelSnapshot): void {
  const layer = doc.getLayer(snapshot.layerId);
  if (!layer) return;

  const { canvas, ctx } = layer;
  if (canvas.width !== snapshot.width || canvas.height !== snapshot.height) {
    // Resizing resets the drawing state but keeps the context object valid.
    canvas.width = snapshot.width;
    canvas.height = snapshot.height;
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (snapshot.width > 0 && snapshot.height > 0) ctx.drawImage(snapshot.bitmap, 0, 0);
}

export function captureDocument(doc: PixelDocument): DocumentSnapshot {
  return {
    width: doc.width,
    height: doc.height,
    activeLayerId: doc.activeLayerId,
    selection: doc.selection,
    layers: doc.layers.map((layer) => ({
      id: layer.id,
      name: layer.name,
      canvas: layer.canvas,
      x: layer.x,
      y: layer.y,
      opacity: layer.opacity,
      blendMode: layer.blendMode,
      visible: layer.visible,
      locked: layer.locked,
      type: layer.type,
      mask: layer.mask,
    })),
  };
}

/** Rebuilds the layer list in place, keeping existing layer objects where it can. */
export function restoreDocument(doc: PixelDocument, snapshot: DocumentSnapshot): void {
  doc.width = snapshot.width;
  doc.height = snapshot.height;

  const existing = new Map(doc.layers.map((layer) => [layer.id, layer]));
  const restored = snapshot.layers.map((record) => applyRecord(existing.get(record.id), record));

  doc.layers.length = 0;
  doc.layers.push(...restored);
  doc.activeLayerId = snapshot.activeLayerId;
  doc.selection = snapshot.selection;
}

function applyRecord(layer: Layer | undefined, record: LayerRecord): Layer {
  if (layer) {
    layer.name = record.name;
    layer.x = record.x;
    layer.y = record.y;
    layer.opacity = record.opacity;
    layer.blendMode = record.blendMode;
    layer.visible = record.visible;
    layer.locked = record.locked;
    layer.type = record.type;
    if (record.mask) layer.mask = record.mask;
    else delete layer.mask;

    if (layer.canvas !== record.canvas) {
      const ctx = record.canvas.getContext('2d');
      if (!ctx) throw new Error('Could not acquire a 2D context while restoring a layer.');
      layer.canvas = record.canvas;
      layer.ctx = ctx;
    }
    return layer;
  }

  // The layer object is gone (it was deleted), so wrap the stored canvas again.
  const ctx = record.canvas.getContext('2d');
  if (!ctx) throw new Error('Could not acquire a 2D context while restoring a layer.');
  const rebuilt: Layer = {
    id: record.id,
    name: record.name,
    canvas: record.canvas,
    ctx,
    x: record.x,
    y: record.y,
    opacity: record.opacity,
    blendMode: record.blendMode,
    visible: record.visible,
    locked: record.locked,
    type: record.type,
  };
  if (record.mask) rebuilt.mask = record.mask;
  return rebuilt;
}

export function documentSnapshotsEqual(a: DocumentSnapshot, b: DocumentSnapshot): boolean {
  if (
    a.width !== b.width ||
    a.height !== b.height ||
    a.activeLayerId !== b.activeLayerId ||
    a.selection !== b.selection ||
    a.layers.length !== b.layers.length
  ) {
    return false;
  }

  for (let i = 0; i < a.layers.length; i++) {
    const left = a.layers[i];
    const right = b.layers[i];
    if (!left || !right) return false;
    if (
      left.id !== right.id ||
      left.name !== right.name ||
      left.canvas !== right.canvas ||
      left.x !== right.x ||
      left.y !== right.y ||
      left.opacity !== right.opacity ||
      left.blendMode !== right.blendMode ||
      left.visible !== right.visible ||
      left.locked !== right.locked ||
      left.type !== right.type ||
      left.mask !== right.mask
    ) {
      return false;
    }
  }
  return true;
}
