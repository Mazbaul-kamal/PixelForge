import { defaultParams } from './adjustments';
import type { AdjustmentData, AdjustmentKind, AdjustmentParams } from './adjustments';
import type { PixelDocument } from './document';
import type { History } from './history';
import { createLayer } from './layer';
import { ADJUSTMENT_NAMES } from './adjustments';
import type { Layer } from './types';

/**
 * Adjustment layers carry no bitmap. A one pixel canvas stands in so that the
 * rest of the layer machinery — thumbnails, snapshots, reordering — needs no
 * special case for them.
 */
export function makeAdjustmentLayer(kind: AdjustmentKind, params?: AdjustmentParams): Layer {
  const layer = createLayer({
    name: ADJUSTMENT_NAMES[kind],
    width: 1,
    height: 1,
    type: 'adjustment',
  });
  layer.adjustment = { kind, params: params ?? defaultParams(kind) };
  return layer;
}

/** Adds an adjustment layer above the active one, with no history entry. */
export function insertAdjustmentLayer(doc: PixelDocument, layer: Layer): void {
  const activeIndex = doc.activeLayerId ? doc.indexOfLayer(doc.activeLayerId) : -1;
  doc.addLayer(layer, activeIndex >= 0 ? activeIndex + 1 : doc.layers.length);
  doc.setActiveLayer(layer.id);
}

/** Records an already-placed adjustment layer as a single history entry. */
export function commitAdjustmentLayer(
  doc: PixelDocument,
  history: History,
  layer: Layer,
  data: AdjustmentData,
): void {
  const index = doc.indexOfLayer(layer.id);
  doc.removeLayer(layer.id);

  history.transaction(`${ADJUSTMENT_NAMES[data.kind]} Layer`, () => {
    layer.adjustment = data;
    doc.addLayer(layer, index < 0 ? doc.layers.length : index);
    doc.setActiveLayer(layer.id);
  });
}

/** Records a change to an existing adjustment layer. */
export function updateAdjustmentLayer(
  doc: PixelDocument,
  history: History,
  layerId: string,
  data: AdjustmentData,
): void {
  const layer = doc.getLayer(layerId);
  if (!layer) return;

  history.transaction(`Edit ${ADJUSTMENT_NAMES[data.kind]}`, () => {
    layer.adjustment = data;
  });
}
