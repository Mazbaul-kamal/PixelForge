import { maskAsAlpha } from './compositor';
import type { PixelDocument } from './document';
import type { History } from './history';
import type { SelectionMask } from './selection';
import { captureLayerPixels, restoreLayerPixels } from './snapshot';
import type { Layer } from './types';

/** Builds a greyscale mask canvas at layer size. */
function createMaskCanvas(layer: Layer, fill: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, layer.canvas.width);
  canvas.height = Math.max(1, layer.canvas.height);

  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

export function addMask(
  doc: PixelDocument,
  history: History,
  layerId: string,
  mode: 'reveal' | 'hide',
): boolean {
  const layer = doc.getLayer(layerId);
  if (!layer || layer.mask) return false;

  return history.transaction(mode === 'reveal' ? 'Add Mask' : 'Add Hiding Mask', () => {
    layer.mask = createMaskCanvas(layer, mode === 'reveal' ? '#ffffff' : '#000000');
    layer.maskEnabled = true;
    layer.maskLinked = true;
  });
}

/**
 * A mask from the current selection: selected areas reveal, the rest hides.
 * The selection is document-sized, so it is drawn at the layer's offset.
 */
export function addMaskFromSelection(
  doc: PixelDocument,
  history: History,
  layerId: string,
  selection: SelectionMask,
): boolean {
  const layer = doc.getLayer(layerId);
  if (!layer) return false;

  return history.transaction('Mask from Selection', () => {
    const canvas = createMaskCanvas(layer, '#000000');
    const ctx = canvas.getContext('2d');
    if (ctx) {
      // The selection's coverage becomes the mask's brightness.
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(selection.canvas, -layer.x, -layer.y);
    }
    layer.mask = canvas;
    layer.maskEnabled = true;
    layer.maskLinked = true;
  });
}

export function deleteMask(doc: PixelDocument, history: History, layerId: string): boolean {
  const layer = doc.getLayer(layerId);
  if (!layer || !layer.mask) return false;

  return history.transaction('Delete Mask', () => {
    delete layer.mask;
    layer.maskEnabled = true;
  });
}

export function setMaskEnabled(
  doc: PixelDocument,
  history: History,
  layerId: string,
  enabled: boolean,
): boolean {
  const layer = doc.getLayer(layerId);
  if (!layer || !layer.mask || layer.maskEnabled === enabled) return false;

  return history.transaction(enabled ? 'Enable Mask' : 'Disable Mask', () => {
    layer.maskEnabled = enabled;
  });
}

export function setMaskLinked(
  doc: PixelDocument,
  history: History,
  layerId: string,
  linked: boolean,
): boolean {
  const layer = doc.getLayer(layerId);
  if (!layer || !layer.mask) return false;

  return history.transaction(linked ? 'Link Mask' : 'Unlink Mask', () => {
    layer.maskLinked = linked;
  });
}

/** Bakes the mask into the layer's pixels and removes it. */
export function applyMask(doc: PixelDocument, history: History, layerId: string): boolean {
  const layer = doc.getLayer(layerId);
  if (!layer || !layer.mask) return false;

  const mask = layer.mask;
  const before = captureLayerPixels(layer);

  layer.ctx.save();
  layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
  layer.ctx.globalAlpha = 1;
  layer.ctx.globalCompositeOperation = 'destination-in';
  layer.ctx.drawImage(maskAsAlpha(mask), 0, 0);
  layer.ctx.restore();

  const after = captureLayerPixels(layer);
  const hadMask = mask;

  history.push(
    'Apply Mask',
    () => {
      restoreLayerPixels(doc, before);
      const target = doc.getLayer(layerId);
      if (target) { target.mask = hadMask; target.maskEnabled = true; }
    },
    () => {
      restoreLayerPixels(doc, after);
      const target = doc.getLayer(layerId);
      if (target) delete target.mask;
    },
  );

  delete layer.mask;
  return true;
}

/** Clips a layer to the alpha of the layer beneath it, or releases it. */
export function setClipped(
  doc: PixelDocument,
  history: History,
  layerId: string,
  clipped: boolean,
): boolean {
  const index = doc.indexOfLayer(layerId);
  const layer = doc.getLayer(layerId);
  if (!layer || index < 1) return false;
  if ((layer.clipped === true) === clipped) return false;

  return history.transaction(clipped ? 'Create Clipping Mask' : 'Release Clipping Mask', () => {
    layer.clipped = clipped;
  });
}
