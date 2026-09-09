import type { Rect } from './types';

export type CombineMode = 'new' | 'add' | 'subtract' | 'intersect';

export interface ShapeOptions {
  /** Feather radius in document pixels. 0 is a crisp edge. */
  feather?: number;
  /** When false the edge is thresholded to fully in or fully out. */
  antiAlias?: boolean;
}

/**
 * The selection is an 8-bit coverage mask at document size, never a rectangle.
 * 255 is fully selected, 0 is outside, and everything between is a feathered
 * or anti-aliased edge. Every shape the app can select — rectangle, ellipse,
 * lasso, wand — reduces to one of these, so no tool has to know which.
 *
 * Instances are immutable. History snapshots hold selections by reference, so
 * every operation returns a new mask rather than editing one in place.
 */
export class SelectionMask {
  readonly width: number;
  readonly height: number;
  /** width x height coverage values. */
  readonly data: Uint8ClampedArray;

  private cachedBounds: Rect | null = null;
  private hasBounds = false;
  private cachedCanvas: HTMLCanvasElement | null = null;

  constructor(width: number, height: number, data?: Uint8ClampedArray) {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.data = data ?? new Uint8ClampedArray(this.width * this.height);
  }

  static empty(width: number, height: number): SelectionMask {
    return new SelectionMask(width, height);
  }

  static all(width: number, height: number): SelectionMask {
    const mask = new SelectionMask(width, height);
    mask.data.fill(255);
    return mask;
  }

  /**
   * Rasterises a shape into a mask. Anti-aliasing is removed by thresholding
   * before the feather blur, so that "no anti-alias, 10px feather" still gives
   * a smooth 10px ramp rather than a stair-stepped one.
   */
  static fromShape(
    width: number,
    height: number,
    draw: (ctx: CanvasRenderingContext2D) => void,
    options: ShapeOptions = {},
  ): SelectionMask {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not acquire a 2D context for a selection mask.');

    ctx.fillStyle = '#ffffff';
    draw(ctx);

    const antiAlias = options.antiAlias ?? true;
    if (!antiAlias) {
      const raw = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const pixels = raw.data;
      for (let i = 3; i < pixels.length; i += 4) {
        pixels[i] = pixels[i]! >= 128 ? 255 : 0;
      }
      ctx.putImageData(raw, 0, 0);
    }

    const feather = Math.max(0, options.feather ?? 0);
    if (feather > 0) {
      const blurred = document.createElement('canvas');
      blurred.width = canvas.width;
      blurred.height = canvas.height;
      const blurredCtx = blurred.getContext('2d', { willReadFrequently: true });
      if (blurredCtx) {
        blurredCtx.filter = `blur(${feather}px)`;
        blurredCtx.drawImage(canvas, 0, 0);
        return SelectionMask.fromAlpha(blurredCtx, canvas.width, canvas.height);
      }
    }

    return SelectionMask.fromAlpha(ctx, canvas.width, canvas.height);
  }

  private static fromAlpha(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
  ): SelectionMask {
    const pixels = ctx.getImageData(0, 0, width, height).data;
    const data = new Uint8ClampedArray(width * height);
    for (let i = 0, p = 3; i < data.length; i++, p += 4) data[i] = pixels[p]!;
    return new SelectionMask(width, height, data);
  }

  isEmpty(): boolean {
    const bounds = this.bounds();
    return bounds.width === 0 || bounds.height === 0;
  }

  /** Tight box of non-zero coverage, computed once and cached. */
  bounds(): Rect {
    if (this.hasBounds && this.cachedBounds) return this.cachedBounds;

    const { width, height, data } = this;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        if (data[row + x] === 0) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    this.cachedBounds =
      maxX < 0
        ? { x: 0, y: 0, width: 0, height: 0 }
        : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
    this.hasBounds = true;
    return this.cachedBounds;
  }

  valueAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.data[y * this.width + x] ?? 0;
  }

  invert(): SelectionMask {
    const data = new Uint8ClampedArray(this.data.length);
    for (let i = 0; i < data.length; i++) data[i] = 255 - this.data[i]!;
    return new SelectionMask(this.width, this.height, data);
  }

  /** Combines with another mask of the same size. */
  combine(other: SelectionMask, mode: CombineMode): SelectionMask {
    if (mode === 'new') return other;

    const data = new Uint8ClampedArray(this.data.length);
    const mine = this.data;
    const theirs = other.data;

    for (let i = 0; i < data.length; i++) {
      const a = mine[i]!;
      const b = theirs[i]!;
      if (mode === 'add') data[i] = a > b ? a : b;
      else if (mode === 'subtract') data[i] = (a * (255 - b)) / 255;
      else data[i] = (a * b) / 255;
    }
    return new SelectionMask(this.width, this.height, data);
  }

  translated(dx: number, dy: number): SelectionMask {
    const shiftX = Math.round(dx);
    const shiftY = Math.round(dy);
    if (shiftX === 0 && shiftY === 0) return this;

    const { width, height } = this;
    const data = new Uint8ClampedArray(width * height);

    for (let y = 0; y < height; y++) {
      const sourceY = y - shiftY;
      if (sourceY < 0 || sourceY >= height) continue;

      const from = sourceY * width;
      const to = y * width;
      for (let x = 0; x < width; x++) {
        const sourceX = x - shiftX;
        if (sourceX < 0 || sourceX >= width) continue;
        data[to + x] = this.data[from + sourceX]!;
      }
    }
    return new SelectionMask(width, height, data);
  }

  /** White-on-transparent image of the mask, built once on demand. */
  get canvas(): HTMLCanvasElement {
    if (this.cachedCanvas) return this.cachedCanvas;

    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not acquire a 2D context for a selection mask.');

    const image = ctx.createImageData(this.width, this.height);
    const pixels = image.data;
    for (let i = 0, p = 0; i < this.data.length; i++, p += 4) {
      pixels[p] = 255;
      pixels[p + 1] = 255;
      pixels[p + 2] = 255;
      pixels[p + 3] = this.data[i]!;
    }
    ctx.putImageData(image, 0, 0);

    this.cachedCanvas = canvas;
    return canvas;
  }

  /**
   * Masks everything already drawn in `ctx` down to the selection.
   *
   * Canvas clipping cannot take an arbitrary alpha mask, so the caller draws
   * freely into a scratch surface and this composites the mask back over it
   * with destination-in. Every painting tool goes through here.
   *
   * `offsetX`/`offsetY` give the scratch surface's position in document space,
   * which for a layer buffer is the layer's origin.
   */
  applyClip(ctx: CanvasRenderingContext2D, offsetX = 0, offsetY = 0): void {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(this.canvas, -offsetX, -offsetY);
    ctx.restore();
  }
}
