import { drawLayers } from './compositor';
import type { PixelDocument } from './document';
import type { History } from './history';
import { createLayer } from './layer';
import type { Layer, Rect } from './types';

/**
 * Layer list operations. Every one of these goes through a history
 * transaction, so the panel never has to think about undo.
 */

/** The single place that decides whether a layer accepts paint or movement. */
export function canEditLayer(layer: Layer | null): boolean {
  return layer !== null && !layer.locked;
}

function layerRect(layer: Layer): Rect {
  return { x: layer.x, y: layer.y, width: layer.canvas.width, height: layer.canvas.height };
}

function unionRect(rects: readonly Rect[]): Rect {
  const first = rects[0];
  if (!first) return { x: 0, y: 0, width: 1, height: 1 };

  let left = first.x;
  let top = first.y;
  let right = first.x + first.width;
  let bottom = first.y + first.height;

  for (const rect of rects.slice(1)) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
  }
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/** Orders the given ids by their current position, bottom-first. */
function orderedLayers(doc: PixelDocument, ids: readonly string[]): Layer[] {
  const wanted = new Set(ids);
  return doc.layers.filter((layer) => wanted.has(layer.id));
}

export function addEmptyLayer(doc: PixelDocument, history: History): string | null {
  let createdId: string | null = null;

  history.transaction('New Layer', () => {
    const layer = createLayer({ width: doc.width, height: doc.height });
    const activeIndex = doc.activeLayerId ? doc.indexOfLayer(doc.activeLayerId) : -1;
    doc.addLayer(layer, activeIndex >= 0 ? activeIndex + 1 : doc.layers.length);
    doc.setActiveLayer(layer.id);
    createdId = layer.id;
  });

  return createdId;
}

/**
 * Copies a layer and inserts the copy directly above it. Records no history,
 * so a caller such as Alt+drag can fold it into its own transaction.
 */
export function cloneLayerAbove(doc: PixelDocument, sourceId: string): Layer | null {
  const source = doc.getLayer(sourceId);
  if (!source) return null;

  const copy = createLayer({
    name: `${source.name} copy`,
    width: source.canvas.width,
    height: source.canvas.height,
    x: source.x,
    y: source.y,
    opacity: source.opacity,
    blendMode: source.blendMode,
    visible: source.visible,
    locked: source.locked,
    type: source.type,
  });
  copy.ctx.drawImage(source.canvas, 0, 0);
  doc.addLayer(copy, doc.indexOfLayer(source.id) + 1);
  return copy;
}

export function duplicateLayers(
  doc: PixelDocument,
  history: History,
  ids: readonly string[],
): string[] {
  const sources = orderedLayers(doc, ids);
  if (sources.length === 0) return [];

  const copies: string[] = [];
  history.transaction(sources.length > 1 ? 'Duplicate Layers' : 'Duplicate Layer', () => {
    // Walk from the top so inserting a copy never shifts a source we still need.
    for (let i = sources.length - 1; i >= 0; i--) {
      const copy = cloneLayerAbove(doc, sources[i]!.id);
      if (copy) copies.unshift(copy.id);
    }
    const top = copies[copies.length - 1];
    if (top) doc.setActiveLayer(top);
  });

  return copies;
}

export function deleteLayers(doc: PixelDocument, history: History, ids: readonly string[]): void {
  const doomed = orderedLayers(doc, ids);
  if (doomed.length === 0) return;

  history.transaction(doomed.length > 1 ? 'Delete Layers' : 'Delete Layer', () => {
    for (const layer of doomed) doc.removeLayer(layer.id);
  });
}

/**
 * Nudges every selected layer one position. `delta` is +1 for up the stack
 * (a higher array index) and -1 for down. Relative order is preserved and the
 * block stops at the ends.
 */
export function moveLayersBy(
  doc: PixelDocument,
  history: History,
  ids: readonly string[],
  delta: 1 | -1,
): boolean {
  const selected = new Set(ids);
  if (selected.size === 0) return false;

  const layers = doc.layers;
  const swap = (a: number, b: number): void => {
    const first = layers[a]!;
    const second = layers[b]!;
    layers[a] = second;
    layers[b] = first;
  };

  return history.transaction(delta > 0 ? 'Move Layer Up' : 'Move Layer Down', () => {
    if (delta > 0) {
      for (let i = layers.length - 2; i >= 0; i--) {
        if (selected.has(layers[i]!.id) && !selected.has(layers[i + 1]!.id)) swap(i, i + 1);
      }
    } else {
      for (let i = 1; i < layers.length; i++) {
        if (selected.has(layers[i]!.id) && !selected.has(layers[i - 1]!.id)) swap(i, i - 1);
      }
    }
  });
}

/**
 * Drag-and-drop reorder. `insertIndex` counts positions among the layers that
 * are NOT moving, bottom-first: 0 puts the block at the very bottom and
 * (layers - moving) puts it at the very top. The dragged rows are excluded
 * because the drop gap is measured against the rows still on screen.
 */
export function reorderLayers(
  doc: PixelDocument,
  history: History,
  ids: readonly string[],
  insertIndex: number,
): boolean {
  const moving = new Set(ids);
  if (moving.size === 0) return false;

  return history.transaction(moving.size > 1 ? 'Reorder Layers' : 'Reorder Layer', () => {
    const block = doc.layers.filter((layer) => moving.has(layer.id));
    const rest = doc.layers.filter((layer) => !moving.has(layer.id));

    const insertAt = Math.min(Math.max(insertIndex, 0), rest.length);
    rest.splice(insertAt, 0, ...block);

    doc.layers.length = 0;
    doc.layers.push(...rest);
  });
}

/**
 * Bakes the upper layer's opacity, blend mode and offset down into the layer
 * beneath it. The result is a plain normal-mode layer at 100%.
 */
export function mergeDown(doc: PixelDocument, history: History, upperId: string): boolean {
  const upperIndex = doc.indexOfLayer(upperId);
  if (upperIndex < 1) return false;

  const upper = doc.layers[upperIndex]!;
  const lower = doc.layers[upperIndex - 1]!;

  return history.transaction('Merge Down', () => {
    const contributing = [lower, upper].filter((layer) => layer.visible && layer.opacity > 0);
    const bounds = unionRect(
      (contributing.length > 0 ? contributing : [lower]).map(layerRect),
    );

    const merged = createLayer({
      name: lower.name,
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      visible: lower.visible,
      locked: lower.locked,
    });
    drawLayers(merged.ctx, [lower, upper], bounds.x, bounds.y);

    doc.removeLayer(upper.id);
    doc.removeLayer(lower.id);
    doc.addLayer(merged, upperIndex - 1);
    doc.setActiveLayer(merged.id);
  });
}

/** Collapses every visible layer into one document-sized layer. */
export function flattenImage(doc: PixelDocument, history: History): boolean {
  if (doc.layers.length === 0) return false;

  return history.transaction('Flatten Image', () => {
    const flat = createLayer({ name: 'Background', width: doc.width, height: doc.height });
    drawLayers(flat.ctx, doc.layers);

    doc.layers.length = 0;
    doc.activeLayerId = null;
    doc.addLayer(flat);
    doc.setActiveLayer(flat.id);
  });
}

export function setLayerVisibility(
  doc: PixelDocument,
  history: History,
  id: string,
  visible: boolean,
): void {
  const layer = doc.getLayer(id);
  if (!layer || layer.visible === visible) return;

  history.transaction(visible ? 'Show Layer' : 'Hide Layer', () => {
    layer.visible = visible;
  });
}

export function setLayerLocked(
  doc: PixelDocument,
  history: History,
  id: string,
  locked: boolean,
): void {
  const layer = doc.getLayer(id);
  if (!layer || layer.locked === locked) return;

  history.transaction(locked ? 'Lock Layer' : 'Unlock Layer', () => {
    layer.locked = locked;
  });
}

export function renameLayer(
  doc: PixelDocument,
  history: History,
  id: string,
  name: string,
): void {
  const layer = doc.getLayer(id);
  const trimmed = name.trim();
  if (!layer || trimmed.length === 0 || layer.name === trimmed) return;

  history.transaction('Rename Layer', () => {
    layer.name = trimmed;
  });
}

export type AlignEdge = 'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom';

/** Aligns a layer's bounds against the document, as one history entry. */
export function alignLayerToDocument(
  doc: PixelDocument,
  history: History,
  id: string,
  edge: AlignEdge,
): boolean {
  const layer = doc.getLayer(id);
  if (!layer || !canEditLayer(layer)) return false;

  const width = layer.canvas.width;
  const height = layer.canvas.height;

  return history.transaction('Align Layer', () => {
    switch (edge) {
      case 'left':
        layer.x = 0;
        break;
      case 'centre':
        layer.x = Math.round((doc.width - width) / 2);
        break;
      case 'right':
        layer.x = doc.width - width;
        break;
      case 'top':
        layer.y = 0;
        break;
      case 'middle':
        layer.y = Math.round((doc.height - height) / 2);
        break;
      case 'bottom':
        layer.y = doc.height - height;
        break;
    }
  });
}
