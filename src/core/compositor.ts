import { WebGLCompositor } from '../view/webgl-compositor';
import { createAdjustment } from './adjustments';
import type { PixelDocument } from './document';
import { TileGrid } from './tiles';
import type { Rect } from './types';
import type { Layer } from './types';
import { blendModeToComposite } from './types';

/**
 * A stroke being painted right now. It lives in its own buffer so that
 * overlapping dabs cannot darken each other, and is shown composited into the
 * layer stack at the right position until the tool commits it.
 */
export interface LiveStroke {
  readonly layerId: string;
  /** Buffer in the target surface's coordinate space, painted at full alpha. */
  readonly canvas: HTMLCanvasElement;
  readonly opacity: number;
  /**
   * How the buffer joins the surface. Not a BlendMode: the eraser needs
   * 'destination-out', which is a compositing operation rather than a blend.
   */
  readonly composite: GlobalCompositeOperation;
  /** Which surface of the layer is being painted. Defaults to the pixels. */
  readonly target?: 'layer' | 'mask';
}

function isGroup(layer: Layer): boolean {
  return layer.type === 'group';
}

/** Layers directly inside `parentId`, bottom first. */
export function childrenOf(layers: readonly Layer[], parentId: string | undefined): Layer[] {
  return layers.filter((layer) => (layer.parentId ?? undefined) === parentId);
}

function isAdjustment(layer: Layer): boolean {
  return layer.type === 'adjustment' && layer.adjustment !== undefined;
}

function isDrawable(layer: Layer): boolean {
  if (!layer.visible || layer.opacity <= 0) return false;
  // Adjustment layers and groups have no bitmap of their own but still count.
  if (isAdjustment(layer) || isGroup(layer)) return true;
  return layer.canvas.width > 0 && layer.canvas.height > 0;
}

export function hasActiveMask(layer: Layer): boolean {
  return layer.mask !== undefined && layer.maskEnabled !== false;
}

const LUMA_FILTER_ID = 'pf-luma-to-alpha';
let lumaFilterReady = false;

/**
 * A mask is greyscale — white reveals, black hides — but destination-in reads
 * the ALPHA channel, and opaque black has full alpha. So the mask's luminance
 * has to become its alpha before it can be used to cut anything out.
 */
function ensureLumaFilter(): void {
  if (lumaFilterReady || document.getElementById(LUMA_FILTER_ID)) {
    lumaFilterReady = true;
    return;
  }

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.position = 'absolute';
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    `<filter id="${LUMA_FILTER_ID}" color-interpolation-filters="sRGB">` +
    '<feColorMatrix type="matrix" values="' +
    '0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0.2126 0.7152 0.0722 0 0"/></filter>';
  document.body.appendChild(svg);
  lumaFilterReady = true;
}

/** The mask converted so that its brightness becomes coverage. */
export function maskAsAlpha(mask: HTMLCanvasElement): HTMLCanvasElement {
  ensureLumaFilter();

  const converted = document.createElement('canvas');
  converted.width = mask.width;
  converted.height = mask.height;

  const ctx = converted.getContext('2d', { willReadFrequently: false });
  if (!ctx) return mask;

  ctx.filter = `url(#${LUMA_FILTER_ID})`;
  ctx.drawImage(mask, 0, 0);
  ctx.filter = 'none';

  // Some engines silently ignore an SVG filter reference; fall back to doing
  // the same conversion by hand rather than showing an unmasked layer.
  const probe = ctx.getImageData(0, 0, 1, 1).data;
  const source = mask.getContext('2d')?.getImageData(0, 0, 1, 1).data;
  if (source) {
    const expected = Math.round(
      (0.2126 * source[0]! + 0.7152 * source[1]! + 0.0722 * source[2]!) * (source[3]! / 255),
    );
    if (Math.abs(probe[3]! - expected) > 4) return maskAsAlphaManually(mask);
  }
  return converted;
}

function maskAsAlphaManually(mask: HTMLCanvasElement): HTMLCanvasElement {
  const converted = document.createElement('canvas');
  converted.width = mask.width;
  converted.height = mask.height;

  const ctx = converted.getContext('2d');
  const sourceCtx = mask.getContext('2d', { willReadFrequently: true });
  if (!ctx || !sourceCtx) return mask;

  const image = sourceCtx.getImageData(0, 0, mask.width, mask.height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const luma = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = luma * (data[i + 3]! / 255);
  }
  ctx.putImageData(image, 0, 0);
  return converted;
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
    if (!isDrawable(layer) || isAdjustment(layer)) continue;
    ctx.globalAlpha = Math.min(Math.max(layer.opacity, 0), 1);
    ctx.globalCompositeOperation = blendModeToComposite(layer.blendMode);
    ctx.drawImage(surfaceFor(layer), layer.x - offsetX, layer.y - offsetY);
  }

  ctx.globalAlpha = previousAlpha;
  ctx.globalCompositeOperation = previousComposite;
}

/**
 * The layer's visible bitmap: its pixels with the mask applied.
 *
 * Canvas cannot clip to an arbitrary alpha mask, so the layer is drawn into a
 * scratch and the mask composited over it with destination-in.
 */
export function surfaceFor(layer: Layer, extra?: LiveStroke): HTMLCanvasElement {
  const stroke = extra && extra.layerId === layer.id ? extra : undefined;
  const maskStroke = stroke?.target === 'mask' ? stroke : undefined;
  const pixelStroke = stroke && stroke.target !== 'mask' ? stroke : undefined;

  if (!hasActiveMask(layer) && !pixelStroke && !maskStroke) return layer.canvas;

  const scratch = document.createElement('canvas');
  scratch.width = layer.canvas.width;
  scratch.height = layer.canvas.height;

  const ctx = scratch.getContext('2d');
  if (!ctx) return layer.canvas;

  ctx.drawImage(layer.canvas, 0, 0);
  if (pixelStroke) {
    ctx.globalAlpha = Math.min(Math.max(pixelStroke.opacity, 0), 1);
    ctx.globalCompositeOperation = pixelStroke.composite;
    ctx.drawImage(pixelStroke.canvas, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  if (!hasActiveMask(layer) || !layer.mask) return scratch;

  let mask: HTMLCanvasElement = layer.mask;
  if (maskStroke) {
    // Painting on the mask has to show through the composite as it happens.
    const edited = document.createElement('canvas');
    edited.width = mask.width;
    edited.height = mask.height;
    const editedCtx = edited.getContext('2d');
    if (editedCtx) {
      editedCtx.drawImage(mask, 0, 0);
      editedCtx.globalAlpha = Math.min(Math.max(maskStroke.opacity, 0), 1);
      editedCtx.globalCompositeOperation = maskStroke.composite;
      editedCtx.drawImage(maskStroke.canvas, 0, 0);
      mask = edited;
    }
  }

  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(maskAsAlpha(mask), 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  return scratch;
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
  /** When set, the view shows only this layer's mask, as greyscale. */
  private maskPreviewLayerId: string | null = null;
  private readonly tiles = new TileGrid();
  /** How long the last recomposite took, for the debug overlay. */
  lastComposeMs = 0;
  lastDirtyTiles = 0;
  /** Scratch used for clipping groups and non-plain layers. */
  private scratch: HTMLCanvasElement | null = null;

  /**
   * The WebGL2 path. It is built lazily and may stay null: a machine without
   * WebGL2, or a driver that will not link the shaders, simply keeps using
   * Canvas 2D rather than showing a black canvas.
   */
  private gl: WebGLCompositor | null = null;
  private glTried = false;
  private glWanted = true;
  /** Which path produced the last composite. */
  activePath: '2d' | 'webgl' = '2d';
  /**
   * Bumped whenever a layer's own pixels may have changed, so the GL path
   * knows when to re-upload. A brush dab does NOT bump it: the wet paint is
   * in the live stroke buffer, not in the layer bitmap.
   */
  private layerRevision = 0;

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

  markDirty(): void {
    this.dirty = true;
    this.layerRevision += 1;
    this.tiles.markAll();
  }

  /**
   * Marks only the tiles a change touched. A brush dab uses this, which is
   * what keeps a stroke on a large document cheap.
   */
  markDirtyRect(rect: Rect): void {
    this.dirty = true;
    this.tiles.resize(this.canvas.width, this.canvas.height);
    this.tiles.markRect(rect);
  }

  get tileStats(): { dirty: number; total: number } {
    return { dirty: this.tiles.dirtyCount, total: this.tiles.tileCount };
  }

  /** The canvas holding the finished composite, whichever path drew it. */
  get outputCanvas(): HTMLCanvasElement {
    return this.activePath === 'webgl' && this.gl ? this.gl.canvas : this.canvas;
  }

  /** The settings toggle. Turning it off returns everything to Canvas 2D. */
  get webglEnabled(): boolean {
    return this.glWanted;
  }

  set webglEnabled(value: boolean) {
    if (this.glWanted === value) return;
    this.glWanted = value;
    this.markDirty();
  }

  /** False when this machine cannot run the GL path at all. */
  get webglAvailable(): boolean {
    return this.ensureGl() !== null;
  }

  get textureBytes(): number {
    return this.gl?.textureBytes ?? 0;
  }

  private ensureGl(): WebGLCompositor | null {
    if (!this.glTried) {
      this.glTried = true;
      this.gl = WebGLCompositor.create();
    }
    return this.gl;
  }

  setLiveStroke(stroke: LiveStroke | null): void {
    this.live = stroke;
    this.markDirty();
  }

  /** Alt+clicking a mask thumbnail shows the mask by itself. */
  setMaskPreview(layerId: string | null): void {
    this.maskPreviewLayerId = layerId;
    this.dirty = true;
  }

  get maskPreview(): string | null {
    return this.maskPreviewLayerId;
  }

  syncSize(): void {
    if (this.canvas.width !== this.doc.width || this.canvas.height !== this.doc.height) {
      this.canvas.width = this.doc.width;
      this.canvas.height = this.doc.height;
    }
    this.tiles.resize(this.canvas.width, this.canvas.height);
    this.markDirty();
  }

  composeIfDirty(): boolean {
    if (!this.dirty) return false;
    this.compose();
    return true;
  }

  private compose(): void {
    const { ctx, doc } = this;
    const started = performance.now();

    if (this.glWanted) {
      const gl = this.ensureGl();
      if (gl && gl.canHandle(doc, this.maskPreviewLayerId)
        && gl.compose(doc, this.live, this.layerRevision)) {
        this.activePath = 'webgl';
        this.dirty = false;
        this.lastDirtyTiles = this.tiles.dirtyCount;
        this.tiles.clean();
        this.lastComposeMs = performance.now() - started;
        return;
      }
    }
    this.activePath = '2d';

    this.tiles.resize(this.canvas.width, this.canvas.height);
    const region = this.tiles.dirtyRegion(this.canvas.width, this.canvas.height)
      ?? { x: 0, y: 0, width: this.canvas.width, height: this.canvas.height };
    this.lastDirtyTiles = this.tiles.dirtyCount;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // Everything below is confined to the dirty region, so an ordinary brush
    // stroke repaints a couple of tiles rather than the whole document.
    const partial = region.width < this.canvas.width || region.height < this.canvas.height;
    if (partial) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(region.x, region.y, region.width, region.height);
      ctx.clip();
    }
    ctx.clearRect(region.x, region.y, region.width, region.height);

    if (this.maskPreviewLayerId) {
      const previewed = doc.getLayer(this.maskPreviewLayerId);
      if (previewed?.mask) {
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.drawImage(previewed.mask, previewed.x, previewed.y);
        if (partial) ctx.restore();
        this.dirty = false;
        this.tiles.clean();
        this.lastComposeMs = performance.now() - started;
        return;
      }
    }

    this.renderSiblings(ctx, this.canvas.width, this.canvas.height, childrenOf(doc.layers, undefined));

    if (partial) ctx.restore();

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    this.dirty = false;
    this.tiles.clean();
    this.lastComposeMs = performance.now() - started;
  }

  /** Draws one level of the layer tree, bottom first. */
  private renderSiblings(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    siblings: readonly Layer[],
  ): void {
    let index = 0;
    while (index < siblings.length) {
      const base = siblings[index]!;
      if (!isDrawable(base)) {
        index++;
        continue;
      }

      // Gather the run of layers clipped to this one.
      const clipped: Layer[] = [];
      let next = index + 1;
      while (next < siblings.length && siblings[next]!.clipped === true) {
        if (isDrawable(siblings[next]!)) clipped.push(siblings[next]!);
        next++;
      }

      if (isAdjustment(base)) {
        this.applyAdjustmentLayer(ctx, width, height, base);
      } else if (clipped.length === 0) {
        this.drawSingle(ctx, base);
      } else {
        this.drawClippingGroup(ctx, width, height, base, clipped);
      }

      index = next;
    }
  }

  /**
   * A group renders its children into their own surface first, so the group's
   * opacity and blend mode apply to the result as a whole rather than to each
   * child separately — which is what makes a 50% group different from setting
   * every child to 50%.
   */
  private renderGroup(layer: Layer, width: number, height: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;

    this.renderSiblings(ctx, width, height, childrenOf(this.doc.layers, layer.id));

    if (hasActiveMask(layer) && layer.mask) {
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(maskAsAlpha(layer.mask), layer.x, layer.y);
      ctx.globalCompositeOperation = 'source-over';
    }
    return canvas;
  }

  private drawSingle(ctx: CanvasRenderingContext2D, layer: Layer): void {
    ctx.globalAlpha = Math.min(Math.max(layer.opacity, 0), 1);
    ctx.globalCompositeOperation = blendModeToComposite(layer.blendMode);

    if (isGroup(layer)) {
      ctx.drawImage(this.renderGroup(layer, ctx.canvas.width, ctx.canvas.height), 0, 0);
    } else {
      ctx.drawImage(surfaceFor(layer, this.live ?? undefined), layer.x, layer.y);
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /**
   * A base layer and everything clipped to it. Each clipped layer is trimmed
   * to the base's alpha, then the whole group composites with the base's own
   * opacity and blend mode.
   */
  private drawClippingGroup(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    base: Layer,
    clipped: readonly Layer[],
  ): void {
    const baseSurface = isGroup(base)
      ? this.renderGroup(base, width, height)
      : surfaceFor(base, this.live ?? undefined);
    const baseX = isGroup(base) ? 0 : base.x;
    const baseY = isGroup(base) ? 0 : base.y;

    const group = this.ensureScratch(width, height);
    const groupCtx = group.getContext('2d');
    if (!groupCtx) return;

    groupCtx.setTransform(1, 0, 0, 1, 0, 0);
    groupCtx.globalAlpha = 1;
    groupCtx.globalCompositeOperation = 'source-over';
    groupCtx.clearRect(0, 0, group.width, group.height);
    groupCtx.drawImage(baseSurface, baseX, baseY);

    for (const layer of clipped) {
      if (isAdjustment(layer)) {
        // A clipped adjustment only reaches the group it belongs to.
        this.applyAdjustmentLayer(groupCtx, group.width, group.height, layer);
        continue;
      }

      const trimmed = document.createElement('canvas');
      trimmed.width = group.width;
      trimmed.height = group.height;
      const trimmedCtx = trimmed.getContext('2d');
      if (!trimmedCtx) continue;

      if (isGroup(layer)) {
        trimmedCtx.drawImage(this.renderGroup(layer, group.width, group.height), 0, 0);
      } else {
        trimmedCtx.drawImage(surfaceFor(layer, this.live ?? undefined), layer.x, layer.y);
      }
      // Trimmed to the BASE's alpha, not to whatever the group has become, so
      // three clipped layers all clip to the same shape.
      trimmedCtx.globalCompositeOperation = 'destination-in';
      trimmedCtx.drawImage(baseSurface, baseX, baseY);

      groupCtx.globalAlpha = Math.min(Math.max(layer.opacity, 0), 1);
      groupCtx.globalCompositeOperation = blendModeToComposite(layer.blendMode);
      groupCtx.drawImage(trimmed, 0, 0);
      groupCtx.globalAlpha = 1;
      groupCtx.globalCompositeOperation = 'source-over';
    }

    ctx.globalAlpha = Math.min(Math.max(base.opacity, 0), 1);
    ctx.globalCompositeOperation = blendModeToComposite(base.blendMode);
    ctx.drawImage(group, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /**
   * Runs an adjustment over whatever has been composited into `target`.
   *
   * The pixels are read back, transformed and blended in by the layer's
   * opacity and its mask coverage, so nothing is baked and turning the layer
   * off recomposites from the original pixels with no accumulated drift.
   */
  private applyAdjustmentLayer(
    target: CanvasRenderingContext2D,
    width: number,
    height: number,
    layer: Layer,
  ): void {
    if (!layer.adjustment) return;

    // Only the masked region needs touching.
    let left = 0;
    let top = 0;
    let region = { width, height };
    if (hasActiveMask(layer) && layer.mask) {
      left = Math.max(0, layer.x);
      top = Math.max(0, layer.y);
      region = {
        width: Math.min(width - left, layer.mask.width),
        height: Math.min(height - top, layer.mask.height),
      };
    }
    if (region.width <= 0 || region.height <= 0) return;

    const image = target.getImageData(left, top, region.width, region.height);
    const original = new Uint8ClampedArray(image.data);

    createAdjustment(layer.adjustment).apply(image.data);

    const opacity = Math.min(Math.max(layer.opacity, 0), 1);
    let coverage: Uint8ClampedArray | null = null;
    if (hasActiveMask(layer) && layer.mask) {
      const alpha = maskAsAlpha(layer.mask);
      const maskCtx = alpha.getContext('2d', { willReadFrequently: true });
      if (maskCtx) {
        coverage = maskCtx.getImageData(
          left - layer.x, top - layer.y, region.width, region.height,
        ).data;
      }
    }

    const data = image.data;
    for (let i = 0, p = 0; i < data.length; i += 4, p += 4) {
      let strength = opacity;
      if (coverage) strength *= coverage[p + 3]! / 255;
      if (strength >= 1) continue;
      if (strength <= 0) {
        for (let c = 0; c < 4; c++) data[i + c] = original[i + c]!;
        continue;
      }
      for (let c = 0; c < 3; c++) {
        data[i + c] = original[i + c]! + (data[i + c]! - original[i + c]!) * strength;
      }
    }

    target.putImageData(image, left, top);
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
