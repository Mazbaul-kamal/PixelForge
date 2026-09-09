/**
 * Perceptual colour comparison.
 *
 * Plain Euclidean RGB distance is a poor match for how people see colour — it
 * selects sky and skin badly — so pixels are converted to CIE Lab and compared
 * there. Conversion is cached per quantised colour because a flood fill asks
 * about the same handful of colours millions of times.
 */

export interface Lab {
  readonly l: number;
  readonly a: number;
  readonly b: number;
}

function linearise(channel: number): number {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function pivot(t: number): number {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

export function rgbToLab(r: number, g: number, b: number): Lab {
  const lr = linearise(r);
  const lg = linearise(g);
  const lb = linearise(b);

  // sRGB to XYZ under D65, then XYZ to Lab.
  const x = pivot((lr * 0.4124 + lg * 0.3576 + lb * 0.1805) / 0.95047);
  const y = pivot(lr * 0.2126 + lg * 0.7152 + lb * 0.0722);
  const z = pivot((lr * 0.0193 + lg * 0.1192 + lb * 0.9505) / 1.08883);

  return { l: 116 * y - 16, a: 500 * (x - y), b: 200 * (y - z) };
}

/** Packed Lab lookup, indexed by a 5-bit-per-channel colour cube. */
export class LabCache {
  private readonly l = new Float32Array(32768);
  private readonly a = new Float32Array(32768);
  private readonly b = new Float32Array(32768);
  private readonly filled = new Uint8Array(32768);

  static binOf(r: number, g: number, b: number): number {
    return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
  }

  lookup(r: number, g: number, b: number): Lab {
    const bin = LabCache.binOf(r, g, b);
    if (this.filled[bin] === 0) {
      const lab = rgbToLab(r, g, b);
      this.l[bin] = lab.l;
      this.a[bin] = lab.a;
      this.b[bin] = lab.b;
      this.filled[bin] = 1;
    }
    return { l: this.l[bin]!, a: this.a[bin]!, b: this.b[bin]! };
  }
}

/** CIE76 difference, which is a plain Euclidean distance in Lab. */
export function labDistance(one: Lab, other: Lab): number {
  const dl = one.l - other.l;
  const da = one.a - other.a;
  const db = one.b - other.b;
  return Math.sqrt(dl * dl + da * da + db * db);
}

/**
 * Tolerance 0-100 as a Lab distance. Lab differences run to about 100 across
 * the whole gamut, so this is close to a one-to-one mapping.
 */
export function toleranceToDistance(tolerance: number): number {
  return Math.max(0, Math.min(100, tolerance));
}

/** Alpha differences count too, or transparent areas match everything. */
export function alphaPenalty(alphaA: number, alphaB: number): number {
  return (Math.abs(alphaA - alphaB) / 255) * 100;
}
