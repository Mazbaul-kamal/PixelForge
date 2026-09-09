import type { Layer, SelectionMask } from './types';

/**
 * The document model. `layers[0]` is the BOTTOM layer, so the layers panel and
 * any UI that reads top-first must reverse this array, never the other way round.
 */
export class PixelDocument {
  width: number;
  height: number;
  readonly layers: Layer[] = [];
  activeLayerId: string | null = null;
  /** Owned by the selection engine in a later step. */
  selection: SelectionMask | null = null;
  /** Used for the export filename and the window title. */
  name = 'Untitled';
  /**
   * True while this is still a fresh document nobody has touched. The first
   * image opened into a pristine document replaces it instead of landing as a
   * floating layer. Latched off by the first history entry.
   */
  pristine = true;

  constructor(width: number, height: number) {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
  }

  /** Inserts a layer. `index` counts from the bottom; omitted means on top. */
  addLayer(layer: Layer, index?: number): Layer {
    const at = index === undefined ? this.layers.length : clampIndex(index, this.layers.length);
    this.layers.splice(at, 0, layer);
    if (this.activeLayerId === null) this.activeLayerId = layer.id;
    return layer;
  }

  removeLayer(id: string): Layer | null {
    const index = this.indexOfLayer(id);
    if (index < 0) return null;

    const [removed] = this.layers.splice(index, 1);
    if (this.activeLayerId === id) {
      const fallback = this.layers[Math.min(index, this.layers.length - 1)];
      this.activeLayerId = fallback ? fallback.id : null;
    }
    return removed ?? null;
  }

  /** Moves the layer at `from` so it ends up at `to` in the new array. */
  moveLayer(from: number, to: number): boolean {
    const count = this.layers.length;
    if (from < 0 || from >= count) return false;

    const target = clampIndex(to, count - 1);
    if (target === from) return false;

    const [layer] = this.layers.splice(from, 1);
    if (!layer) return false;
    this.layers.splice(target, 0, layer);
    return true;
  }

  getActiveLayer(): Layer | null {
    if (this.activeLayerId === null) return null;
    return this.getLayer(this.activeLayerId);
  }

  setActiveLayer(id: string | null): void {
    if (id === null || this.indexOfLayer(id) >= 0) this.activeLayerId = id;
  }

  getLayer(id: string): Layer | null {
    return this.layers.find((layer) => layer.id === id) ?? null;
  }

  indexOfLayer(id: string): number {
    return this.layers.findIndex((layer) => layer.id === id);
  }
}

function clampIndex(value: number, max: number): number {
  if (!Number.isFinite(value)) return max;
  return Math.min(Math.max(Math.round(value), 0), max);
}
