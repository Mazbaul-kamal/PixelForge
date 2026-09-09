import { alphaPenalty, LabCache, labDistance, toleranceToDistance } from './colour-distance';
import type { Lab } from './colour-distance';

export interface FloodInput {
  /** RGBA, width x height x 4. */
  readonly pixels: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly tolerance: number;
  readonly antiAlias: boolean;
}

export interface WandInput extends FloodInput {
  readonly seedX: number;
  readonly seedY: number;
  readonly contiguous: boolean;
}

/** Where the anti-aliased ramp starts, as a fraction of the threshold. */
const RAMP_START = 0.7;

/**
 * Distance from one reference colour to every 5-bit colour bin, computed on
 * demand. A flood fill asks about the same few thousand colours millions of
 * times, so this turns the inner loop into one array read.
 */
class DistanceField {
  private readonly cache = new Float32Array(32768).fill(-1);
  private readonly labs = new LabCache();
  private readonly reference: Lab;

  constructor(reference: Lab) {
    this.reference = reference;
  }

  distance(r: number, g: number, b: number): number {
    const bin = LabCache.binOf(r, g, b);
    let value = this.cache[bin]!;
    if (value < 0) {
      value = labDistance(this.labs.lookup(r, g, b), this.reference);
      this.cache[bin] = value;
    }
    return value;
  }
}

function coverageFor(distance: number, threshold: number, antiAlias: boolean): number {
  if (distance > threshold) return 0;
  if (!antiAlias) return 255;

  const rampStart = threshold * RAMP_START;
  if (distance <= rampStart) return 255;

  const span = Math.max(1e-6, threshold - rampStart);
  return Math.round(255 * (1 - (distance - rampStart) / span));
}

/**
 * Magic wand. Contiguous mode is a scanline span fill: it walks whole runs at
 * a time instead of pushing every pixel, which on a large image is far faster
 * than four-way recursion and cannot build a huge stack.
 */
export function wandSelect(input: WandInput): Uint8ClampedArray {
  const { pixels, width, height, seedX, seedY, contiguous, antiAlias } = input;
  const threshold = toleranceToDistance(input.tolerance);
  const mask = new Uint8ClampedArray(width * height);

  const sx = Math.max(0, Math.min(width - 1, Math.floor(seedX)));
  const sy = Math.max(0, Math.min(height - 1, Math.floor(seedY)));
  const seedOffset = (sy * width + sx) * 4;

  const labs = new LabCache();
  const seedLab = labs.lookup(pixels[seedOffset]!, pixels[seedOffset + 1]!, pixels[seedOffset + 2]!);
  const seedAlpha = pixels[seedOffset + 3]!;
  const field = new DistanceField(seedLab);

  const distanceAt = (index: number): number => {
    const p = index * 4;
    return (
      field.distance(pixels[p]!, pixels[p + 1]!, pixels[p + 2]!) +
      alphaPenalty(pixels[p + 3]!, seedAlpha)
    );
  };

  if (!contiguous) {
    for (let i = 0; i < mask.length; i++) {
      mask[i] = coverageFor(distanceAt(i), threshold, antiAlias);
    }
    return mask;
  }

  const visited = new Uint8Array(width * height);
  const matches = (x: number, y: number): boolean => distanceAt(y * width + x) <= threshold;

  const stack: number[] = [sx, sy];
  while (stack.length > 0) {
    const y = stack.pop()!;
    const x = stack.pop()!;
    const row = y * width;
    if (visited[row + x] === 1 || !matches(x, y)) continue;

    let left = x;
    while (left > 0 && visited[row + left - 1] === 0 && matches(left - 1, y)) left--;
    let right = x;
    while (right < width - 1 && visited[row + right + 1] === 0 && matches(right + 1, y)) right++;

    for (let i = left; i <= right; i++) {
      visited[row + i] = 1;
      mask[row + i] = coverageFor(distanceAt(row + i), threshold, antiAlias);
    }

    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= height) continue;
      const nrow = ny * width;
      let i = left;
      while (i <= right) {
        while (i <= right && (visited[nrow + i] === 1 || !matches(i, ny))) i++;
        if (i > right) break;
        stack.push(i, ny);
        while (i <= right && visited[nrow + i] === 0 && matches(i, ny)) i++;
      }
    }
  }

  return mask;
}

export interface SeededInput extends FloodInput {
  /** Current selection coverage, width x height. */
  readonly seeds: Uint8ClampedArray;
}

/** Reference colours taken from the selection, capped so Similar stays quick. */
function paletteOf(input: SeededInput, limit = 256): Lab[] {
  const { pixels, seeds } = input;
  const labs = new LabCache();
  const seen = new Uint8Array(32768);
  const palette: Lab[] = [];

  for (let i = 0; i < seeds.length && palette.length < limit; i++) {
    if (seeds[i]! < 128) continue;
    const p = i * 4;
    const bin = LabCache.binOf(pixels[p]!, pixels[p + 1]!, pixels[p + 2]!);
    if (seen[bin] === 1) continue;
    seen[bin] = 1;
    palette.push(labs.lookup(pixels[p]!, pixels[p + 1]!, pixels[p + 2]!));
  }
  return palette;
}

/** Selects every pixel in the image close to any colour already selected. */
export function selectSimilar(input: SeededInput): Uint8ClampedArray {
  const { pixels, width, height, antiAlias } = input;
  const threshold = toleranceToDistance(input.tolerance);
  const palette = paletteOf(input);
  const mask = new Uint8ClampedArray(width * height);
  if (palette.length === 0) return mask;

  const labs = new LabCache();
  // One decision per colour bin, reused for every pixel of that colour.
  const decided = new Int16Array(32768).fill(-1);

  for (let i = 0; i < mask.length; i++) {
    const p = i * 4;
    const bin = LabCache.binOf(pixels[p]!, pixels[p + 1]!, pixels[p + 2]!);
    let value = decided[bin]!;

    if (value < 0) {
      const lab = labs.lookup(pixels[p]!, pixels[p + 1]!, pixels[p + 2]!);
      let best = Infinity;
      for (const reference of palette) {
        const d = labDistance(lab, reference);
        if (d < best) best = d;
        if (best <= threshold * RAMP_START) break;
      }
      value = coverageFor(best, threshold, antiAlias);
      decided[bin] = value;
    }
    mask[i] = value;
  }
  return mask;
}

/** Expands the selection into neighbouring pixels within tolerance. */
export function growSelection(input: SeededInput): Uint8ClampedArray {
  const { pixels, width, height, seeds, antiAlias } = input;
  const threshold = toleranceToDistance(input.tolerance);

  const labs = new LabCache();
  let count = 0;
  let l = 0;
  let a = 0;
  let b = 0;
  for (let i = 0; i < seeds.length; i++) {
    if (seeds[i]! < 128) continue;
    const p = i * 4;
    const lab = labs.lookup(pixels[p]!, pixels[p + 1]!, pixels[p + 2]!);
    l += lab.l;
    a += lab.a;
    b += lab.b;
    count++;
  }
  if (count === 0) return new Uint8ClampedArray(seeds);

  const field = new DistanceField({ l: l / count, a: a / count, b: b / count });
  const mask = new Uint8ClampedArray(seeds);
  const queue: number[] = [];

  for (let i = 0; i < seeds.length; i++) if (seeds[i]! >= 128) queue.push(i);

  // Breadth-first from everything already selected, so growth follows the
  // shape of the selection rather than flooding from one point.
  while (queue.length > 0) {
    const index = queue.pop()!;
    const x = index % width;
    const y = (index - x) / width;

    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const neighbour = ny * width + nx;
      if (mask[neighbour]! >= 128) continue;

      const p = neighbour * 4;
      const distance = field.distance(pixels[p]!, pixels[p + 1]!, pixels[p + 2]!);
      if (distance > threshold) continue;

      mask[neighbour] = coverageFor(distance, threshold, antiAlias);
      if (mask[neighbour]! >= 128) queue.push(neighbour);
    }
  }
  return mask;
}
