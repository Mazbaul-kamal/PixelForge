import type { AdjustmentData } from './adjustments';
import type { PixelDocument } from './document';
import { createLayer } from './layer';
import { SelectionMask } from './selection';
import type { DocumentGuide } from './guides';
import { createChannel } from './channels';
import type { LayerStyles } from './layer-styles';
import type { VectorPath } from './path';
import type { ShapeData } from './shape-layer';
import type { TextLayerData } from './text-layer';
import type { BlendMode, Layer, LayerType } from './types';

export const PROJECT_VERSION = 1;

/** The selection mask always lives under this key within a project. */
export const SELECTION_KEY = 'selection.png';

export interface StoredLayer {
  readonly id: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly opacity: number;
  readonly blendMode: BlendMode;
  readonly visible: boolean;
  readonly locked: boolean;
  readonly type: LayerType;
  readonly parentId?: string;
  readonly clipped?: boolean;
  readonly collapsed?: boolean;
  readonly maskEnabled?: boolean;
  readonly maskLinked?: boolean;
  readonly text?: TextLayerData;
  readonly shape?: ShapeData;
  readonly adjustment?: AdjustmentData;
  readonly styles?: LayerStyles;
  readonly stylesEnabled?: boolean;
  /** Key of this layer's bitmap in the blob map. */
  readonly bitmapKey?: string;
  readonly maskKey?: string;
}

export interface StoredDocument {
  readonly version: number;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly activeLayerId: string | null;
  readonly layers: readonly StoredLayer[];
  readonly selectionKey?: string;
  readonly viewport: { readonly zoom: number; readonly panX: number; readonly panY: number };
  readonly paths?: readonly VectorPath[];
  readonly activePathId?: string | null;
  readonly workPathId?: string | null;
  readonly guides?: readonly DocumentGuide[];
  readonly channels?: readonly StoredChannel[];
}

/** A stored selection. The coverage lives in a PNG beside the document. */
export interface StoredChannel {
  readonly id: string;
  readonly name: string;
  readonly key: string;
  readonly colour: string;
  readonly opacity: number;
  readonly visible: boolean;
}

export interface SerialisedProject {
  readonly document: StoredDocument;
  /** PNG blobs, keyed by the names the document refers to. */
  readonly blobs: Map<string, Blob>;
}

function toPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

export interface SerialiseOptions {
  readonly viewport: { zoom: number; panX: number; panY: number };
  /**
   * Bitmaps whose key is already stored and unchanged. An autosave passes the
   * previous set so it only writes what actually moved.
   */
  readonly reuse?: ReadonlySet<string>;
}

/** A stable key for a layer's bitmap within one project. */
function bitmapKeyFor(layer: Layer, kind: 'layer' | 'mask'): string {
  return `${layer.id}.${kind}.png`;
}

/**
 * Turns the document into JSON plus PNG blobs.
 *
 * Bitmaps are blobs rather than data URLs: a base64 string of a megabyte
 * bitmap is a third larger again and has to be parsed back on load.
 */
export async function serialiseProject(
  doc: PixelDocument,
  options: SerialiseOptions,
): Promise<SerialisedProject> {
  const blobs = new Map<string, Blob>();
  const layers: StoredLayer[] = [];

  for (const layer of doc.layers) {
    const bitmapKey = layer.type === 'group' || layer.type === 'adjustment'
      ? undefined
      : bitmapKeyFor(layer, 'layer');
    const maskKey = layer.mask ? bitmapKeyFor(layer, 'mask') : undefined;

    if (bitmapKey && !options.reuse?.has(bitmapKey)) {
      const blob = await toPngBlob(layer.canvas);
      if (blob) blobs.set(bitmapKey, blob);
    }
    if (maskKey && layer.mask && !options.reuse?.has(maskKey)) {
      const blob = await toPngBlob(layer.mask);
      if (blob) blobs.set(maskKey, blob);
    }

    layers.push({
      id: layer.id,
      name: layer.name,
      x: layer.x,
      y: layer.y,
      width: layer.canvas.width,
      height: layer.canvas.height,
      opacity: layer.opacity,
      blendMode: layer.blendMode,
      visible: layer.visible,
      locked: layer.locked,
      type: layer.type,
      ...(layer.parentId ? { parentId: layer.parentId } : {}),
      ...(layer.clipped ? { clipped: true } : {}),
      ...(layer.collapsed ? { collapsed: true } : {}),
      ...(layer.mask ? { maskEnabled: layer.maskEnabled !== false, maskLinked: layer.maskLinked !== false } : {}),
      ...(layer.text ? { text: layer.text } : {}),
      ...(layer.shape ? { shape: layer.shape } : {}),
      ...(layer.adjustment ? { adjustment: layer.adjustment } : {}),
      ...(layer.styles ? { styles: layer.styles, stylesEnabled: layer.stylesEnabled !== false } : {}),
      ...(bitmapKey ? { bitmapKey } : {}),
      ...(maskKey ? { maskKey } : {}),
    });
  }

  const channels: StoredChannel[] = [];
  for (const channel of doc.channels) {
    const key = `channel-${channel.id}.png`;
    // Channel masks are document-sized, so they honour reuse like a layer.
    if (!options.reuse?.has(key)) {
      const blob = await toPngBlob(channel.mask.canvas);
      if (blob) blobs.set(key, blob);
    }
    channels.push({
      id: channel.id, name: channel.name, key,
      colour: channel.colour, opacity: channel.opacity, visible: channel.visible,
    });
  }

  let selectionKey: string | undefined;
  if (doc.selection) {
    selectionKey = SELECTION_KEY;
    // The selection is document-sized, so it honours reuse just like a layer.
    if (!options.reuse?.has(selectionKey)) {
      const blob = await toPngBlob(doc.selection.canvas);
      if (blob) blobs.set(selectionKey, blob);
    }
  }

  return {
    document: {
      version: PROJECT_VERSION,
      name: doc.name,
      width: doc.width,
      height: doc.height,
      activeLayerId: doc.activeLayerId,
      layers,
      ...(selectionKey ? { selectionKey } : {}),
      ...(doc.paths.length > 0
        ? { paths: doc.paths, activePathId: doc.activePathId, workPathId: doc.workPathId }
        : {}),
      ...(doc.guides.length > 0 ? { guides: doc.guides } : {}),
      ...(channels.length > 0 ? { channels } : {}),
      viewport: { ...options.viewport },
    },
    blobs,
  };
}

async function blobToCanvas(blob: Blob, width: number, height: number): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);

  const bitmap = await createImageBitmap(blob);
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

/** Rebuilds a document in place from stored JSON and blobs. */
export async function restoreProject(
  doc: PixelDocument,
  stored: StoredDocument,
  blobs: ReadonlyMap<string, Blob>,
): Promise<{ zoom: number; panX: number; panY: number }> {
  const rebuilt: Layer[] = [];

  for (const record of stored.layers) {
    const layer = createLayer({
      name: record.name,
      width: Math.max(1, record.width),
      height: Math.max(1, record.height),
      x: record.x,
      y: record.y,
      opacity: record.opacity,
      blendMode: record.blendMode,
      visible: record.visible,
      locked: record.locked,
      type: record.type,
    });
    // The saved id is kept so parent links and the active layer still resolve.
    Object.defineProperty(layer, 'id', { value: record.id, writable: false, enumerable: true });

    const bitmap = record.bitmapKey ? blobs.get(record.bitmapKey) : undefined;
    if (bitmap) {
      const canvas = await blobToCanvas(bitmap, record.width, record.height);
      layer.ctx.drawImage(canvas, 0, 0);
    }

    const maskBlob = record.maskKey ? blobs.get(record.maskKey) : undefined;
    if (maskBlob) {
      layer.mask = await blobToCanvas(maskBlob, record.width, record.height);
      layer.maskEnabled = record.maskEnabled !== false;
      layer.maskLinked = record.maskLinked !== false;
    }

    if (record.parentId) layer.parentId = record.parentId;
    if (record.clipped) layer.clipped = true;
    if (record.collapsed) layer.collapsed = true;
    if (record.text) layer.text = record.text;
    if (record.shape) layer.shape = record.shape;
    if (record.adjustment) layer.adjustment = record.adjustment;
    if (record.styles) {
      layer.styles = record.styles;
      layer.stylesEnabled = record.stylesEnabled !== false;
    }

    rebuilt.push(layer);
  }

  doc.width = stored.width;
  doc.height = stored.height;
  doc.name = stored.name;
  doc.layers.length = 0;
  doc.activeLayerId = null;
  for (const layer of rebuilt) doc.addLayer(layer);
  if (stored.activeLayerId) doc.setActiveLayer(stored.activeLayerId);

  doc.paths = stored.paths ? stored.paths.map((path) => ({
    ...path,
    subpaths: path.subpaths.map((sub) => ({
      closed: sub.closed,
      anchors: sub.anchors.map((anchor) => ({ ...anchor })),
    })),
  })) : [];
  doc.activePathId = stored.activePathId ?? null;
  doc.workPathId = stored.workPathId ?? null;
  doc.guides = stored.guides ? stored.guides.map((guide) => ({ ...guide })) : [];

  doc.selection = null;
  const selectionBlob = stored.selectionKey ? blobs.get(stored.selectionKey) : undefined;
  if (selectionBlob) {
    const canvas = await blobToCanvas(selectionBlob, stored.width, stored.height);
    const data = canvas.getContext('2d')?.getImageData(0, 0, stored.width, stored.height);
    if (data) {
      const coverage = new Uint8ClampedArray(stored.width * stored.height);
      for (let i = 0, p = 3; i < coverage.length; i++, p += 4) coverage[i] = data.data[p]!;
      doc.selection = new SelectionMask(stored.width, stored.height, coverage);
    }
  }

  doc.channels = [];
  for (const record of stored.channels ?? []) {
    const blob = blobs.get(record.key);
    if (!blob) continue;
    const canvas = await blobToCanvas(blob, stored.width, stored.height);
    const data = canvas.getContext('2d')?.getImageData(0, 0, stored.width, stored.height);
    if (!data) continue;
    const coverage = new Uint8ClampedArray(stored.width * stored.height);
    for (let i = 0, p = 3; i < coverage.length; i++, p += 4) coverage[i] = data.data[p]!;
    doc.channels.push({
      ...createChannel(record.name, new SelectionMask(stored.width, stored.height, coverage)),
      id: record.id,
      colour: record.colour,
      opacity: record.opacity,
      visible: record.visible,
    });
  }

  doc.pristine = false;
  return stored.viewport;
}

/** Keys the stored document refers to, for reuse across autosaves. */
export function keysOf(stored: StoredDocument): Set<string> {
  const keys = new Set<string>();
  for (const layer of stored.layers) {
    if (layer.bitmapKey) keys.add(layer.bitmapKey);
    if (layer.maskKey) keys.add(layer.maskKey);
  }
  if (stored.selectionKey) keys.add(stored.selectionKey);
  for (const channel of stored.channels ?? []) keys.add(channel.key);
  return keys;
}
