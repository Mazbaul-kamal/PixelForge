export type FilterKind =
  | 'gaussian-blur' | 'motion-blur' | 'sharpen' | 'unsharp-mask'
  | 'add-noise' | 'median' | 'pixelate' | 'high-pass';

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

export function applyFilter(request: FilterRequest): Uint8ClampedArray {
  const { kind, params, pixels, width, height } = request;

  switch (kind) {
    case 'gaussian-blur':
      return gaussianBlur(pixels, width, height, num(params, 'radius', 4));

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
  }
}
