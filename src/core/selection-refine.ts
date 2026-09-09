import { SelectionMask } from './selection';

/**
 * Refinements that work on any mask, whatever shape produced it.
 *
 * Expand and contract go through a chamfer distance transform and threshold
 * it, which is one linear pass in each direction rather than a per-pixel
 * neighbourhood search. Feather is three box blurs, which approximates a
 * Gaussian closely enough and stays fast on a full-size mask.
 */

const DIAGONAL = Math.SQRT2;

/** Distance from every pixel to the nearest pixel that passes `inside`. */
function distanceTransform(
  width: number,
  height: number,
  inside: (index: number) => boolean,
): Float32Array {
  const distance = new Float32Array(width * height);
  const far = width + height;

  for (let i = 0; i < distance.length; i++) distance[i] = inside(i) ? 0 : far;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let best = distance[i]!;
      if (x > 0) best = Math.min(best, distance[i - 1]! + 1);
      if (y > 0) best = Math.min(best, distance[i - width]! + 1);
      if (x > 0 && y > 0) best = Math.min(best, distance[i - width - 1]! + DIAGONAL);
      if (x < width - 1 && y > 0) best = Math.min(best, distance[i - width + 1]! + DIAGONAL);
      distance[i] = best;
    }
  }

  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      let best = distance[i]!;
      if (x < width - 1) best = Math.min(best, distance[i + 1]! + 1);
      if (y < height - 1) best = Math.min(best, distance[i + width]! + 1);
      if (x < width - 1 && y < height - 1) best = Math.min(best, distance[i + width + 1]! + DIAGONAL);
      if (x > 0 && y < height - 1) best = Math.min(best, distance[i + width - 1]! + DIAGONAL);
      distance[i] = best;
    }
  }

  return distance;
}

export function expandSelection(mask: SelectionMask, radius: number): SelectionMask {
  if (radius <= 0) return mask;

  const { width, height, data } = mask;
  const distance = distanceTransform(width, height, (i) => data[i]! >= 128);
  const next = new Uint8ClampedArray(data.length);
  for (let i = 0; i < next.length; i++) next[i] = distance[i]! <= radius ? 255 : 0;
  return new SelectionMask(width, height, next);
}

export function contractSelection(mask: SelectionMask, radius: number): SelectionMask {
  if (radius <= 0) return mask;

  const { width, height, data } = mask;
  // Distance to the nearest OUTSIDE pixel: shrink by cutting everything within
  // `radius` of the boundary.
  const distance = distanceTransform(width, height, (i) => data[i]! < 128);
  const next = new Uint8ClampedArray(data.length);
  for (let i = 0; i < next.length; i++) next[i] = distance[i]! > radius ? 255 : 0;
  return new SelectionMask(width, height, next);
}

/** One separable box blur pass, horizontal then vertical. */
function boxBlur(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): Uint8ClampedArray {
  const horizontal = new Uint8ClampedArray(source.length);
  const span = radius * 2 + 1;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let x = -radius; x <= radius; x++) {
      sum += source[row + Math.min(width - 1, Math.max(0, x))]!;
    }
    for (let x = 0; x < width; x++) {
      horizontal[row + x] = sum / span;
      const leaving = source[row + Math.min(width - 1, Math.max(0, x - radius))]!;
      const entering = source[row + Math.min(width - 1, Math.max(0, x + radius + 1))]!;
      sum += entering - leaving;
    }
  }

  const vertical = new Uint8ClampedArray(source.length);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) {
      sum += horizontal[Math.min(height - 1, Math.max(0, y)) * width + x]!;
    }
    for (let y = 0; y < height; y++) {
      vertical[y * width + x] = sum / span;
      const leaving = horizontal[Math.min(height - 1, Math.max(0, y - radius)) * width + x]!;
      const entering = horizontal[Math.min(height - 1, Math.max(0, y + radius + 1)) * width + x]!;
      sum += entering - leaving;
    }
  }

  return vertical;
}

/** Three box blurs, which is close enough to a Gaussian and much cheaper. */
export function featherSelection(mask: SelectionMask, radius: number): SelectionMask {
  const box = Math.round(radius);
  if (box <= 0) return mask;

  let data: Uint8ClampedArray = mask.data;
  for (let pass = 0; pass < 3; pass++) {
    data = boxBlur(data, mask.width, mask.height, box);
  }
  return new SelectionMask(mask.width, mask.height, data);
}

/** Rounds off jagged edges by blurring and re-thresholding. */
export function smoothSelection(mask: SelectionMask, radius: number): SelectionMask {
  const box = Math.max(1, Math.round(radius));
  let data: Uint8ClampedArray = mask.data;
  for (let pass = 0; pass < 2; pass++) {
    data = boxBlur(data, mask.width, mask.height, box);
  }

  const next = new Uint8ClampedArray(data.length);
  for (let i = 0; i < next.length; i++) next[i] = data[i]! >= 128 ? 255 : 0;
  return new SelectionMask(mask.width, mask.height, next);
}
