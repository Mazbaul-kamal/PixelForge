import type { PixelDocument } from './document';
import type { History } from './history';
import { canEditLayer } from './layer-ops';
import type { SelectionMask } from './selection';
import { captureLayerPixels, restoreLayerPixels } from './snapshot';
import { blendModeToComposite } from './types';
import type { BlendMode, Layer } from './types';

export interface FillOptions {
  /** 0..1 */
  readonly opacity: number;
  readonly blendMode: BlendMode;
}

/**
 * Fills a layer through one or more coverage masks.
 *
 * The colour or pattern is painted into a patch and then cut down by every
 * mask with destination-in, so an anti-aliased region boundary blends into
 * what is underneath. Writing RGBA straight into the pixels would leave the
 * pale halo that this tool is usually judged by.
 */
export function fillThroughMasks(
  doc: PixelDocument,
  history: History,
  layer: Layer,
  paintPatch: (ctx: CanvasRenderingContext2D, width: number, height: number) => void,
  masks: readonly (SelectionMask | null)[],
  options: FillOptions,
  label: string,
): boolean {
  if (!canEditLayer(layer)) return false;

  const width = layer.canvas.width;
  const height = layer.canvas.height;
  if (width === 0 || height === 0) return false;

  const patch = document.createElement('canvas');
  patch.width = width;
  patch.height = height;

  const patchCtx = patch.getContext('2d');
  if (!patchCtx) return false;

  paintPatch(patchCtx, width, height);
  for (const mask of masks) {
    if (mask) mask.applyClip(patchCtx, layer.x, layer.y);
  }

  const before = captureLayerPixels(layer);

  layer.ctx.save();
  layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
  layer.ctx.globalAlpha = Math.min(Math.max(options.opacity, 0), 1);
  layer.ctx.globalCompositeOperation = blendModeToComposite(options.blendMode);
  layer.ctx.drawImage(patch, 0, 0);
  layer.ctx.restore();

  const after = captureLayerPixels(layer);
  history.push(
    label,
    () => restoreLayerPixels(doc, before),
    () => restoreLayerPixels(doc, after),
  );
  return true;
}

/** Paints a flat colour across the whole patch. */
export function solidPaint(colour: string) {
  return (ctx: CanvasRenderingContext2D, width: number, height: number): void => {
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, width, height);
  };
}

/** Tiles a pattern across the patch, anchored to the layer's own origin. */
export function patternPaint(tile: CanvasImageSource) {
  return (ctx: CanvasRenderingContext2D, width: number, height: number): void => {
    const pattern = ctx.createPattern(tile, 'repeat');
    if (!pattern) return;
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, width, height);
  };
}
