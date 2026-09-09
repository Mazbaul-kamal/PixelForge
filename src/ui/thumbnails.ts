import type { Layer } from '../core/types';

const THUMB_INTERVAL_MS = 300;
const CHECKER_CELL = 4;

/**
 * Layer thumbnails are expensive to redraw, so they are throttled: a dirty
 * layer is regenerated at most once every 300ms, and never while a pointer is
 * down, so a brush stroke is never interrupted by thumbnail work.
 *
 * Each layer keeps one canvas element for its lifetime, so rows can re-append
 * the same node instead of rebuilding it.
 */
export class ThumbnailCache {
  readonly size: number;
  onUpdate: (() => void) | null = null;

  private readonly canvases = new Map<string, HTMLCanvasElement>();
  private readonly dirty = new Set<string>();
  private readonly getLayers: () => readonly Layer[];
  private readonly dpr: number;

  private activePointers = 0;
  private lastRun = 0;
  private timer = 0;

  constructor(getLayers: () => readonly Layer[], size = 36) {
    this.getLayers = getLayers;
    this.size = size;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    window.addEventListener('pointerdown', this.onPointerDown, true);
    window.addEventListener('pointerup', this.onPointerUp, true);
    window.addEventListener('pointercancel', this.onPointerUp, true);
  }

  destroy(): void {
    if (this.timer !== 0) clearTimeout(this.timer);
    this.timer = 0;
    window.removeEventListener('pointerdown', this.onPointerDown, true);
    window.removeEventListener('pointerup', this.onPointerUp, true);
    window.removeEventListener('pointercancel', this.onPointerUp, true);
  }

  /** The canvas for a layer, created on demand. May briefly show stale pixels. */
  canvasFor(layer: Layer): HTMLCanvasElement {
    let canvas = this.canvases.get(layer.id);
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.className = 'pf-thumb-canvas';
      canvas.width = Math.round(this.size * this.dpr);
      canvas.height = Math.round(this.size * this.dpr);
      this.canvases.set(layer.id, canvas);
      this.dirty.add(layer.id);
      this.schedule();
    }
    return canvas;
  }

  markDirty(layerId: string): void {
    this.dirty.add(layerId);
    this.schedule();
  }

  markAllDirty(): void {
    for (const layer of this.getLayers()) this.dirty.add(layer.id);
    this.schedule();
  }

  /** Drops cached canvases for layers that no longer exist. */
  prune(): void {
    const alive = new Set(this.getLayers().map((layer) => layer.id));
    for (const id of [...this.canvases.keys()]) {
      if (!alive.has(id)) {
        this.canvases.delete(id);
        this.dirty.delete(id);
      }
    }
  }

  private readonly onPointerDown = (): void => {
    this.activePointers += 1;
  };

  private readonly onPointerUp = (): void => {
    this.activePointers = Math.max(0, this.activePointers - 1);
    if (this.activePointers === 0 && this.dirty.size > 0) this.schedule();
  };

  private schedule(): void {
    if (this.timer !== 0 || this.dirty.size === 0) return;

    const elapsed = performance.now() - this.lastRun;
    const wait = this.activePointers > 0 ? THUMB_INTERVAL_MS : Math.max(0, THUMB_INTERVAL_MS - elapsed);

    this.timer = window.setTimeout(() => {
      this.timer = 0;
      // Still mid-drag: hold off rather than stealing time from the stroke.
      if (this.activePointers > 0) {
        this.schedule();
        return;
      }
      this.run();
    }, wait);
  }

  private run(): void {
    this.lastRun = performance.now();

    const layers = new Map(this.getLayers().map((layer) => [layer.id, layer]));
    for (const id of this.dirty) {
      const layer = layers.get(id);
      const canvas = this.canvases.get(id);
      if (layer && canvas) this.paint(canvas, layer);
    }
    this.dirty.clear();
    this.onUpdate?.();
  }

  private paint(canvas: HTMLCanvasElement, layer: Layer): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { width, height } = canvas;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // The checkerboard lives in the thumbnail only, never in the composite.
    const cell = CHECKER_CELL * this.dpr;
    ctx.fillStyle = '#cfcfcf';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#f2f2f2';
    for (let y = 0; y < height; y += cell) {
      for (let x = 0; x < width; x += cell) {
        if (((x / cell) + (y / cell)) % 2 === 0) ctx.fillRect(x, y, cell, cell);
      }
    }

    const source = layer.canvas;
    if (source.width === 0 || source.height === 0) return;

    const scale = Math.min(width / source.width, height / source.height);
    const drawWidth = source.width * scale;
    const drawHeight = source.height * scale;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low';
    ctx.globalAlpha = layer.visible ? 1 : 0.35;
    ctx.drawImage(source, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
    ctx.globalAlpha = 1;
  }
}
