import type { PixelDocument } from './document';
import type { History } from './history';
import { canEditLayer } from './layer-ops';
import { SelectionMask } from './selection';
import { captureLayerPixels, restoreLayerPixels } from './snapshot';

/** Replaces the document selection as one undoable step. */
export function setSelection(
  doc: PixelDocument,
  history: History,
  mask: SelectionMask | null,
  label: string,
): void {
  const next = mask && !mask.isEmpty() ? mask : null;
  if (next === doc.selection) return;

  history.transaction(label, () => {
    doc.selection = next;
  });
}

export function selectAll(doc: PixelDocument, history: History): void {
  setSelection(doc, history, SelectionMask.all(doc.width, doc.height), 'Select All');
}

export function deselect(doc: PixelDocument, history: History): void {
  if (!doc.selection) return;
  history.transaction('Deselect', () => {
    doc.selection = null;
  });
}

/** Inverting nothing selects everything, which is what users expect. */
export function invertSelection(doc: PixelDocument, history: History): void {
  const current = doc.selection;
  const inverted = current
    ? current.invert()
    : SelectionMask.all(doc.width, doc.height);
  setSelection(doc, history, inverted, 'Inverse Selection');
}

/** Clears the selected pixels of the active layer. */
export function deleteSelectedPixels(doc: PixelDocument, history: History): boolean {
  const layer = doc.getActiveLayer();
  if (!canEditLayer(layer) || !layer) return false;

  const selection = doc.selection;
  const before = captureLayerPixels(layer);

  layer.ctx.save();
  layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
  layer.ctx.globalAlpha = 1;
  if (selection) {
    layer.ctx.globalCompositeOperation = 'destination-out';
    layer.ctx.drawImage(selection.canvas, -layer.x, -layer.y);
  } else {
    layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
  }
  layer.ctx.restore();

  const after = captureLayerPixels(layer);
  history.push(
    'Clear',
    () => restoreLayerPixels(doc, before),
    () => restoreLayerPixels(doc, after),
  );
  return true;
}

/** Fills the selection, or the whole layer when there is none. */
export function fillSelection(
  doc: PixelDocument,
  history: History,
  colour: string,
  label = 'Fill',
): boolean {
  const layer = doc.getActiveLayer();
  if (!canEditLayer(layer) || !layer) return false;

  const selection = doc.selection;
  const before = captureLayerPixels(layer);

  if (!selection) {
    layer.ctx.save();
    layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
    layer.ctx.globalAlpha = 1;
    layer.ctx.globalCompositeOperation = 'source-over';
    layer.ctx.fillStyle = colour;
    layer.ctx.fillRect(0, 0, layer.canvas.width, layer.canvas.height);
    layer.ctx.restore();
  } else {
    // Paint into a scratch surface, then let the mask cut it down: canvas
    // clipping cannot take an arbitrary alpha mask.
    const patch = document.createElement('canvas');
    patch.width = layer.canvas.width;
    patch.height = layer.canvas.height;

    const patchCtx = patch.getContext('2d');
    if (!patchCtx) return false;

    patchCtx.fillStyle = colour;
    patchCtx.fillRect(0, 0, patch.width, patch.height);
    selection.applyClip(patchCtx, layer.x, layer.y);

    layer.ctx.save();
    layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
    layer.ctx.globalAlpha = 1;
    layer.ctx.globalCompositeOperation = 'source-over';
    layer.ctx.drawImage(patch, 0, 0);
    layer.ctx.restore();
  }

  const after = captureLayerPixels(layer);
  history.push(
    label,
    () => restoreLayerPixels(doc, before),
    () => restoreLayerPixels(doc, after),
  );
  return true;
}
