import type { PixelDocument } from './document';
import type { Layer } from './types';
import { blendModeToComposite } from './types';

/**
 * A stroke being painted right now. It lives in its own buffer so that
 * overlapping dabs cannot darken each other, and is shown composited into the
 * layer stack at the right position until the tool commits it.
 */
export interface LiveStroke {
  readonly layerId: string;
  /** Buffer in the target layer's coordinate space, painted at full alpha. */
  readonly canvas: HTMLCanvasElement;
  readonly opacity: number;
  /**
   * How the buffer joins the layer. Not a BlendMode: the eraser needs
   * 'destination-out', which is a compositing operation rather than a blend.
   */
  readonly composite: GlobalCompositeOperation;
}

/**
 * Draws layers bottom-first into `ctx`, honouring opacity and blend mode.
 * Shared by the compositor and by merge/flatten so there is exactly one place
 * that decides what a stack of layers looks like.
 */
export function drawLayers(
  ctx: CanvasRenderingContext2D,
  layers: readonly Layer[],
  offsetX = 0,
  offsetY = 0,
): void {
  const previousAlpha = ctx.globalAlpha;
  const previousComposite = ctx.globalCompositeOperation;

  for (const layer of layers) {
    if (!isDrawable(layer)) continue;
    ctx.globalAlpha = Math.min(Math.max(layer.opacity, 0), 1);
    ctx.globalCompositeOperation = blendModeToComposite(layer.blendMode);
    ctx.drawImage(layer.canvas, layer.x - offsetX, layer.y - offsetY);
  }

  ctx.globalAlpha = previousAlpha;
  ctx.globalCompositeOperation = previousComposite;
}

function isDrawable(layer: Layer): boolean {
  return (
    layer.visible &&
    layer.opacity > 0 &&
    layer.canvas.width > 0 &&
    layer.canvas.height > 0
  );
}

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
  private live: LiveStroke | null = null;
  /** Scratch used only when a stroke lands on a layer that is not plain. */
  private scratch: HTMLCanvasElement | null = null;

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

  /** Shows or clears the stroke currently being painted. */
  setLiveStroke(stroke: LiveStroke | null): void {
    this.live = stroke;
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

    if (!this.live) {
      drawLayers(ctx, doc.layers);
    } else {
      for (const layer of doc.layers) {
        if (!isDrawable(layer)) continue;
        if (layer.id === this.live.layerId) this.drawLayerWithStroke(layer, this.live);
        else drawLayers(ctx, [layer]);
      }
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    this.dirty = false;
  }

  /**
   * Paint has to join the layer's pixels BEFORE the layer's own opacity and
   * blend mode apply, otherwise a stroke on a 50% layer previews at the wrong
   * strength. A plain layer can take the fast path; anything else is combined
   * in a scratch canvas first.
   */
  private drawLayerWithStroke(layer: Layer, live: LiveStroke): void {
    const { ctx } = this;
    // The fast path is only safe when the stroke lands on the layer exactly as
    // it would on the composite. Any other compositing operation has to happen
    // against the layer's own pixels, not against the layers underneath it.
    const plain =
      layer.opacity >= 1 &&
      layer.blendMode === 'normal' &&
      live.composite === 'source-over';

    if (plain) {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(layer.canvas, layer.x, layer.y);
      ctx.globalAlpha = Math.min(Math.max(live.opacity, 0), 1);
      ctx.globalCompositeOperation = live.composite;
      ctx.drawImage(live.canvas, layer.x, layer.y);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      return;
    }

    const scratch = this.ensureScratch(layer.canvas.width, layer.canvas.height);
    const scratchCtx = scratch.getContext('2d');
    if (!scratchCtx) return;

    scratchCtx.setTransform(1, 0, 0, 1, 0, 0);
    scratchCtx.globalAlpha = 1;
    scratchCtx.globalCompositeOperation = 'source-over';
    scratchCtx.clearRect(0, 0, scratch.width, scratch.height);
    scratchCtx.drawImage(layer.canvas, 0, 0);
    scratchCtx.globalAlpha = Math.min(Math.max(live.opacity, 0), 1);
    scratchCtx.globalCompositeOperation = live.composite;
    scratchCtx.drawImage(live.canvas, 0, 0);
    scratchCtx.globalAlpha = 1;
    scratchCtx.globalCompositeOperation = 'source-over';

    ctx.globalAlpha = Math.min(Math.max(layer.opacity, 0), 1);
    ctx.globalCompositeOperation = blendModeToComposite(layer.blendMode);
    ctx.drawImage(scratch, layer.x, layer.y);
  }

  private ensureScratch(width: number, height: number): HTMLCanvasElement {
    let scratch = this.scratch;
    if (!scratch) {
      scratch = document.createElement('canvas');
      this.scratch = scratch;
    }
    if (scratch.width !== width || scratch.height !== height) {
      scratch.width = width;
      scratch.height = height;
    }
    return scratch;
  }
}
