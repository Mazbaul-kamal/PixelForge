import type { Dab } from './stroke-engine';
import type { Layer } from './types';

/**
 * Helpers for brushes that read and write the layer bitmap per dab.
 *
 * Every read and write is confined to the dab's own bounding box. Reading the
 * whole canvas per dab is the difference between a smooth stroke and single
 * digit frame rates on a large image.
 */

export interface DabPatch {
  readonly image: ImageData;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export function dabBox(layer: Layer, dab: Dab): DabPatch | null {
  const reach = Math.ceil(dab.radius) + 1;
  const left = Math.max(0, Math.floor(dab.x - reach));
  const top = Math.max(0, Math.floor(dab.y - reach));
  const right = Math.min(layer.canvas.width, Math.ceil(dab.x + reach));
  const bottom = Math.min(layer.canvas.height, Math.ceil(dab.y + reach));

  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;

  return { image: layer.ctx.getImageData(left, top, width, height), left, top, width, height };
}

export function writeDabBox(layer: Layer, patch: DabPatch): void {
  layer.ctx.putImageData(patch.image, patch.left, patch.top);
}

/**
 * Coverage of one pixel by the dab: 1 in the solid core, falling to 0 at the
 * rim, matching the radial gradient the ordinary brush stamps.
 */
export function dabCoverage(
  dab: Dab,
  hardness: number,
  x: number,
  y: number,
): number {
  const distance = Math.hypot(x + 0.5 - dab.x, y + 0.5 - dab.y);
  if (distance >= dab.radius) return 0;

  const core = dab.radius * Math.min(0.999, Math.max(0, hardness));
  if (distance <= core) return dab.alpha;

  const falloff = 1 - (distance - core) / Math.max(1e-6, dab.radius - core);
  return dab.alpha * falloff;
}

/** Rec. 709 luminance, 0..1. */
export function luminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

export type ToneRange = 'shadows' | 'midtones' | 'highlights';

/**
 * How strongly a tone should be affected by dodge or burn.
 *
 * Weighting by the existing tone is what stops "highlights" mode from
 * touching dark pixels, and keeps the effect from clipping straight to white.
 */
export function toneWeight(range: ToneRange, light: number): number {
  switch (range) {
    case 'shadows':
      return (1 - light) * (1 - light);
    case 'highlights':
      return light * light;
    case 'midtones': {
      const offset = 2 * light - 1;
      return 1 - offset * offset;
    }
  }
}
