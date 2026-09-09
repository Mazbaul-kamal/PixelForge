import type { PixelDocument } from './document';
import { blendModeToComposite } from './types';

/**
 * The single offscreen canvas at document size that every layer is drawn into.
 * The transparency checkerboard is NEVER drawn in here: blend modes must
 * composite against transparency, not against the checker pattern.
 */
export class Compositor {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  private readonly doc: PixelDocument;
  private dirty = true;

  constructor(doc: PixelDocument) {
    this.doc = doc;
    this.canvas = document.createElement('canvas');
    this.canvas.width = doc.width;
    this.canvas.height = doc.height;

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Could not acquire a 2D context for the compositor.');
    this.ctx = ctx;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  /** Called by anything that changes pixels, layer order or layer properties. */
  markDirty(): void {
    this.dirty = true;
  }

  /** Resizes the composite to match the document. Always leaves it dirty. */
  syncSize(): void {
    if (this.canvas.width !== this.doc.width || this.canvas.height !== this.doc.height) {
      this.canvas.width = this.doc.width;
      this.canvas.height = this.doc.height;
    }
    this.dirty = true;
  }

  /** Redraws only when dirty. Returns true if the composite actually changed. */
  composeIfDirty(): boolean {
    if (!this.dirty) return false;
    this.compose();
    return true;
  }

  private compose(): void {
    const { ctx, doc } = this;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    for (const layer of doc.layers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      if (layer.canvas.width === 0 || layer.canvas.height === 0) continue;

      ctx.globalAlpha = Math.min(Math.max(layer.opacity, 0), 1);
      ctx.globalCompositeOperation = blendModeToComposite(layer.blendMode);
      ctx.drawImage(layer.canvas, layer.x, layer.y);
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    this.dirty = false;
  }
}
