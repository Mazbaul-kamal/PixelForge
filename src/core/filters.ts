export type FilterKind =
  | 'gaussian-blur' | 'motion-blur' | 'sharpen' | 'unsharp-mask'
  | 'add-noise' | 'median' | 'pixelate' | 'high-pass'
  | 'emboss' | 'find-edges' | 'surface-blur' | 'twirl' | 'vignette';

export interface FilterParams {
  readonly [key: string]: number | boolean | undefined;
}

export interface FilterRequest {
  readonly kind: FilterKind;
  readonly params: FilterParams;
  readonly pixels: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

const num = (params: FilterParams, key: string, fallback: number): number => {
  const value = params[key];
  return typeof value === 'number' ? value : fallback;
};

/**
 * One separable box blur pass over RGBA.
 *
 * Three of these approximate a Gaussian closely enough to be indistinguishable
 * and cost a fraction of a true convolution, which is why the blur is built
 * this way rather than from a kernel.
 */
function boxBlurPass(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): Uint8ClampedArray {
  if (radius < 1) return source;
  const span = radius * 2 + 1;

  const horizontal = new Uint8ClampedArray(source.length);
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    const sums = [0, 0, 0, 0];
    for (let x = -radius; x <= radius; x++) {
      const sx = Math.min(width - 1, Math.max(0, x)) * 4;
      for (let c = 0; c < 4; c++) sums[c]! += source[row + sx + c]!;
    }
    for (let x = 0; x < width; x++) {
      const at = row + x * 4;
      for (let c = 0; c < 4; c++) horizontal[at + c] = sums[c]! / span;

      const leaving = row + Math.min(width - 1, Math.max(0, x - radius)) * 4;
      const entering = row + Math.min(width - 1, Math.max(0, x + radius + 1)) * 4;
      for (let c = 0; c < 4; c++) sums[c]! += source[entering + c]! - source[leaving + c]!;
    }
  }

  const vertical = new Uint8ClampedArray(source.length);
  for (let x = 0; x < width; x++) {
    const column = x * 4;
    const sums = [0, 0, 0, 0];
    for (let y = -radius; y <= radius; y++) {
      const sy = Math.min(height - 1, Math.max(0, y)) * width * 4;
      for (let c = 0; c < 4; c++) sums[c]! += horizontal[sy + column + c]!;
    }
    for (let y = 0; y < height; y++) {
      const at = y * width * 4 + column;
      for (let c = 0; c < 4; c++) vertical[at + c] = sums[c]! / span;

      const leaving = Math.min(height - 1, Math.max(0, y - radius)) * width * 4 + column;
      const entering = Math.min(height - 1, Math.max(0, y + radius + 1)) * width * 4 + column;
      for (let c = 0; c < 4; c++) sums[c]! += horizontal[entering + c]! - horizontal[leaving + c]!;
    }
  }
  return vertical;
}

export function gaussianBlur(
  pixels: Uint8ClampedArray, width: number, height: number, radius: number,
): Uint8ClampedArray {
  const box = Math.round(radius);
  if (box < 1) return new Uint8ClampedArray(pixels);

  let data: Uint8ClampedArray = pixels;
  for (let pass = 0; pass < 3; pass++) data = boxBlurPass(data, width, height, box);
  return data;
}

function motionBlur(
  pixels: Uint8ClampedArray, width: number, height: number, distance: number, angle: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels.length);
  const steps = Math.max(1, Math.round(distance));
  const dx = Math.cos((angle * Math.PI) / 180);
  const dy = Math.sin((angle * Math.PI) / 180);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sums = [0, 0, 0, 0];
      let counted = 0;
      // Sampled along the line of travel in both directions.
      for (let s = -steps / 2; s <= steps / 2; s++) {
        const sx = Math.round(x + dx * s);
        const sy = Math.round(y + dy * s);
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
        const at = (sy * width + sx) * 4;
        for (let c = 0; c < 4; c++) sums[c]! += pixels[at + c]!;
        counted++;
      }
      const at = (y * width + x) * 4;
      for (let c = 0; c < 4; c++) out[at + c] = counted === 0 ? pixels[at + c]! : sums[c]! / counted;
    }
  }
  return out;
}

/** Convolution with a fixed 3x3 kernel, used by sharpen. */
function convolve3(
  pixels: Uint8ClampedArray, width: number, height: number, kernel: readonly number[],
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sums = [0, 0, 0];
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const sx = Math.min(width - 1, Math.max(0, x + kx));
          const sy = Math.min(height - 1, Math.max(0, y + ky));
          const weight = kernel[(ky + 1) * 3 + (kx + 1)]!;
          const at = (sy * width + sx) * 4;
          for (let c = 0; c < 3; c++) sums[c]! += pixels[at + c]! * weight;
        }
      }
      const at = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) out[at + c] = sums[c]!;
      out[at + 3] = pixels[at + 3]!;
    }
  }
  return out;
}

/** Median of a square neighbourhood, which removes speckles without blurring. */
function median(
  pixels: Uint8ClampedArray, width: number, height: number, radius: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels.length);
  const window: number[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        window.length = 0;
        for (let ky = -radius; ky <= radius; ky++) {
          for (let kx = -radius; kx <= radius; kx++) {
            const sx = Math.min(width - 1, Math.max(0, x + kx));
            const sy = Math.min(height - 1, Math.max(0, y + ky));
            window.push(pixels[(sy * width + sx) * 4 + c]!);
          }
        }
        window.sort((a, b) => a - b);
        out[at + c] = window[(window.length - 1) >> 1]!;
      }
      out[at + 3] = pixels[at + 3]!;
    }
  }
  return out;
}

/**
 * Sobel gradient magnitude per channel.
 *
 * Photoshop's Find Edges returns a light image with dark edges, which is the
 * inverse of the raw magnitude, so that is what this produces.
 */
function findEdges(
  source: Uint8ClampedArray, width: number, height: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(source.length);
  const at = (x: number, y: number, c: number): number => {
    const cx = x < 0 ? 0 : x >= width ? width - 1 : x;
    const cy = y < 0 ? 0 : y >= height ? height - 1 : y;
    return source[(cy * width + cx) * 4 + c]!;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const gx =
          -at(x - 1, y - 1, c) + at(x + 1, y - 1, c)
          - 2 * at(x - 1, y, c) + 2 * at(x + 1, y, c)
          - at(x - 1, y + 1, c) + at(x + 1, y + 1, c);
        const gy =
          -at(x - 1, y - 1, c) - 2 * at(x, y - 1, c) - at(x + 1, y - 1, c)
          + at(x - 1, y + 1, c) + 2 * at(x, y + 1, c) + at(x + 1, y + 1, c);
        out[i + c] = 255 - Math.hypot(gx, gy);
      }
      out[i + 3] = source[i + 3]!;
    }
  }
  return out;
}

/** A directional difference, pivoted around mid grey the way Emboss is. */
function emboss(
  source: Uint8ClampedArray, width: number, height: number,
  angle: number, depth: number, amount: number,
): Uint8ClampedArray {
  const radians = (angle * Math.PI) / 180;
  const dx = Math.cos(radians) * depth;
  const dy = -Math.sin(radians) * depth;
  const out = new Uint8ClampedArray(source.length);

  const sample = (x: number, y: number, c: number): number => {
    const cx = Math.round(x < 0 ? 0 : x >= width ? width - 1 : x);
    const cy = Math.round(y < 0 ? 0 : y >= height ? height - 1 : y);
    return source[(cy * width + cx) * 4 + c]!;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const difference = sample(x - dx, y - dy, c) - sample(x + dx, y + dy, c);
        out[i + c] = 128 + difference * amount;
      }
      out[i + 3] = source[i + 3]!;
    }
  }
  return out;
}

/**
 * A blur that stops at edges: neighbours only count when they are within the
 * threshold of the centre pixel, so flat areas smooth and detail survives.
 *
 * Run as two one-dimensional passes rather than one square window. A true
 * bilateral filter is not separable, but the approximation is visually very
 * close and turns a radius-30 kernel from 3721 samples per pixel into 122,
 * which is the difference between usable and unusable on a large layer.
 */
function surfaceBlurPass(
  source: Uint8ClampedArray, width: number, height: number,
  radius: number, threshold: number, horizontal: boolean,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(source.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;

      for (let c = 0; c < 3; c++) {
        const centre = source[i + c]!;
        let sum = 0;
        let count = 0;

        for (let step = -radius; step <= radius; step++) {
          const nx = horizontal ? x + step : x;
          const ny = horizontal ? y : y + step;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

          const value = source[(ny * width + nx) * 4 + c]!;
          if (Math.abs(value - centre) <= threshold) {
            sum += value;
            count += 1;
          }
        }

        out[i + c] = count > 0 ? sum / count : centre;
      }
      out[i + 3] = source[i + 3]!;
    }
  }
  return out;
}

function surfaceBlur(
  source: Uint8ClampedArray, width: number, height: number,
  radius: number, threshold: number,
): Uint8ClampedArray {
  if (radius < 1) return source;
  return surfaceBlurPass(
    surfaceBlurPass(source, width, height, radius, threshold, true),
    width, height, radius, threshold, false,
  );
}

/** Bilinear sample, so a warped result is not stair-stepped. */
function sampleBilinear(
  source: Uint8ClampedArray, width: number, height: number,
  x: number, y: number, target: Uint8ClampedArray, at: number,
): void {
  const cx = Math.min(width - 1, Math.max(0, x));
  const cy = Math.min(height - 1, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;

  for (let c = 0; c < 4; c++) {
    const p00 = source[(y0 * width + x0) * 4 + c]!;
    const p10 = source[(y0 * width + x1) * 4 + c]!;
    const p01 = source[(y1 * width + x0) * 4 + c]!;
    const p11 = source[(y1 * width + x1) * 4 + c]!;
    const top = p00 + (p10 - p00) * fx;
    const bottom = p01 + (p11 - p01) * fx;
    target[at + c] = top + (bottom - top) * fy;
  }
}

/** Rotates pixels around the centre, the twist fading out to the radius. */
function twirl(
  source: Uint8ClampedArray, width: number, height: number,
  angle: number, radiusPercent: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(source.length);
  const cx = width / 2;
  const cy = height / 2;
  const reach = (Math.min(width, height) / 2) * (radiusPercent / 100);
  const maximum = (angle * Math.PI) / 180;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      const distance = Math.hypot(dx, dy);

      if (distance >= reach || reach <= 0) {
        for (let c = 0; c < 4; c++) out[i + c] = source[i + c]!;
        continue;
      }

      // Full twist at the centre, none at the edge of the reach.
      const strength = ((reach - distance) / reach) ** 2;
      const theta = Math.atan2(dy, dx) - maximum * strength;
      sampleBilinear(source, width, height,
        cx + Math.cos(theta) * distance, cy + Math.sin(theta) * distance, out, i);
    }
  }
  return out;
}

/** Darkens or lightens toward the corners. */
function vignette(
  source: Uint8ClampedArray, width: number, height: number,
  amount: number, midpoint: number, roundness: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(source);
  const cx = width / 2;
  const cy = height / 2;
  // Roundness bends the falloff between a circle and the frame's own shape.
  const scale = Math.max(0.01, roundness / 100);
  const rx = cx * scale + cx * (1 - scale) * (width / Math.max(width, height));
  const ry = cy * scale + cy * (1 - scale) * (height / Math.max(width, height));
  const start = Math.min(0.99, Math.max(0.01, midpoint / 100));
  const strength = amount / 100;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      const distance = Math.hypot(nx, ny);
      if (distance <= start) continue;

      const t = Math.min(1, (distance - start) / (1.4142 - start));
      const factor = 1 + strength * (t * t);
      for (let c = 0; c < 3; c++) out[i + c] = source[i + c]! * factor;
    }
  }
  return out;
}

export function applyFilter(request: FilterRequest): Uint8ClampedArray {
  const { kind, params, pixels, width, height } = request;

  switch (kind) {
    case 'gaussian-blur':
      return gaussianBlur(pixels, width, height, num(params, 'radius', 4));

    case 'find-edges':
      return findEdges(pixels, width, height);

    case 'emboss':
      return emboss(pixels, width, height,
        num(params, 'angle', 135), num(params, 'depth', 2), num(params, 'amount', 100) / 100);

    case 'surface-blur':
      return surfaceBlur(pixels, width, height,
        Math.round(num(params, 'radius', 5)), num(params, 'threshold', 15));

    case 'twirl':
      return twirl(pixels, width, height, num(params, 'angle', 50), num(params, 'radius', 100));

    case 'vignette':
      return vignette(pixels, width, height,
        num(params, 'amount', -40), num(params, 'midpoint', 50), num(params, 'roundness', 100));

    case 'motion-blur':
      return motionBlur(pixels, width, height, num(params, 'distance', 20), num(params, 'angle', 0));

    case 'sharpen': {
      const amount = num(params, 'amount', 50) / 100;
      const centre = 1 + 4 * amount;
      return convolve3(pixels, width, height, [
        0, -amount, 0,
        -amount, centre, -amount,
        0, -amount, 0,
      ]);
    }

    case 'unsharp-mask': {
      const radius = num(params, 'radius', 2);
      const amount = num(params, 'amount', 80) / 100;
      const threshold = num(params, 'threshold', 3);
      const blurred = gaussianBlur(pixels, width, height, radius);
      const out = new Uint8ClampedArray(pixels);

      for (let i = 0; i < pixels.length; i += 4) {
        for (let c = 0; c < 3; c++) {
          const difference = pixels[i + c]! - blurred[i + c]!;
          // The threshold is what stops it amplifying sensor noise.
          if (Math.abs(difference) < threshold) continue;
          out[i + c] = pixels[i + c]! + difference * amount;
        }
      }
      return out;
    }

    case 'add-noise': {
      const amount = num(params, 'amount', 12);
      const monochrome = params['monochrome'] === true;
      const out = new Uint8ClampedArray(pixels);
      let seed = 0x2f6e2b1 >>> 0;
      const random = (): number => {
        seed ^= seed << 13; seed >>>= 0;
        seed ^= seed >>> 17;
        seed ^= seed << 5; seed >>>= 0;
        return seed / 0xffffffff;
      };

      for (let i = 0; i < out.length; i += 4) {
        if (monochrome) {
          const noise = (random() - 0.5) * 2 * amount;
          for (let c = 0; c < 3; c++) out[i + c] = pixels[i + c]! + noise;
        } else {
          for (let c = 0; c < 3; c++) out[i + c] = pixels[i + c]! + (random() - 0.5) * 2 * amount;
        }
      }
      return out;
    }

    case 'median':
      return median(pixels, width, height, Math.max(1, Math.round(num(params, 'radius', 1))));

    case 'pixelate': {
      const size = Math.max(2, Math.round(num(params, 'size', 10)));
      const out = new Uint8ClampedArray(pixels.length);

      for (let by = 0; by < height; by += size) {
        for (let bx = 0; bx < width; bx += size) {
          const sums = [0, 0, 0, 0];
          let counted = 0;
          for (let y = by; y < Math.min(height, by + size); y++) {
            for (let x = bx; x < Math.min(width, bx + size); x++) {
              const at = (y * width + x) * 4;
              for (let c = 0; c < 4; c++) sums[c]! += pixels[at + c]!;
              counted++;
            }
          }
          if (counted === 0) continue;
          for (let y = by; y < Math.min(height, by + size); y++) {
            for (let x = bx; x < Math.min(width, bx + size); x++) {
              const at = (y * width + x) * 4;
              for (let c = 0; c < 4; c++) out[at + c] = sums[c]! / counted;
            }
          }
        }
      }
      return out;
    }

    case 'high-pass': {
      const radius = num(params, 'radius', 3);
      const blurred = gaussianBlur(pixels, width, height, radius);
      const out = new Uint8ClampedArray(pixels.length);
      // What the blur removed, centred on mid grey.
      for (let i = 0; i < pixels.length; i += 4) {
        for (let c = 0; c < 3; c++) out[i + c] = pixels[i + c]! - blurred[i + c]! + 128;
        out[i + 3] = pixels[i + 3]!;
      }
      return out;
    }
  }
}

export const FILTER_NAMES: Record<FilterKind, string> = {
  'gaussian-blur': 'Gaussian Blur',
  'motion-blur': 'Motion Blur',
  sharpen: 'Sharpen',
  'unsharp-mask': 'Unsharp Mask',
  'add-noise': 'Add Noise',
  median: 'Median',
  pixelate: 'Pixelate',
  'high-pass': 'High Pass',
  emboss: 'Emboss',
  'find-edges': 'Find Edges',
  'surface-blur': 'Surface Blur',
  twirl: 'Twirl',
  vignette: 'Vignette',
};

export function defaultFilterParams(kind: FilterKind): FilterParams {
  switch (kind) {
    case 'gaussian-blur': return { radius: 4 };
    case 'motion-blur': return { distance: 20, angle: 0 };
    case 'sharpen': return { amount: 50 };
    case 'unsharp-mask': return { radius: 2, amount: 80, threshold: 3 };
    case 'add-noise': return { amount: 12, monochrome: false };
    case 'median': return { radius: 1 };
    case 'pixelate': return { size: 10 };
    case 'high-pass': return { radius: 3 };
    case 'emboss': return { angle: 135, depth: 2, amount: 100 };
    case 'find-edges': return {};
    case 'surface-blur': return { radius: 5, threshold: 15 };
    case 'twirl': return { angle: 50, radius: 100 };
    case 'vignette': return { amount: -40, midpoint: 50, roundness: 100 };
  }
}
