export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface Hsl {
  readonly h: number;
  readonly s: number;
  readonly l: number;
}

export function srgbToLinear(channel: number): number {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(value: number): number {
  const v = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}

/**
 * Averages a square of pixels in linear light.
 *
 * Averaging sRGB values directly is the usual mistake: sRGB is a gamma-encoded
 * curve, so the naive mean of a light and a dark pixel lands darker than the
 * light those pixels actually carry.
 */
export function averageSample(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  centreX: number,
  centreY: number,
  size: number,
): Rgb & { a: number } {
  const radius = Math.floor(Math.max(1, size) / 2);
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  let count = 0;

  for (let y = centreY - radius; y <= centreY + radius; y++) {
    if (y < 0 || y >= height) continue;
    for (let x = centreX - radius; x <= centreX + radius; x++) {
      if (x < 0 || x >= width) continue;

      const offset = (y * width + x) * 4;
      r += srgbToLinear(pixels[offset]!);
      g += srgbToLinear(pixels[offset + 1]!);
      b += srgbToLinear(pixels[offset + 2]!);
      a += pixels[offset + 3]!;
      count++;
    }
  }

  if (count === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: linearToSrgb(r / count),
    g: linearToSrgb(g / count),
    b: linearToSrgb(b / count),
    a: Math.round(a / count),
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const hex = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

export function hexToRgb(hex: string): Rgb | null {
  const value = hex.trim().replace(/^#/, '');
  if (value.length === 3) {
    const [r, g, b] = value;
    if (!r || !g || !b) return null;
    return {
      r: parseInt(r + r, 16),
      g: parseInt(g + g, 16),
      b: parseInt(b + b, 16),
    };
  }
  if (value.length !== 6 || !/^[0-9a-f]{6}$/i.test(value)) return null;
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;

  if (max === min) return { h: 0, s: 0, l: l * 100 };

  const delta = max - min;
  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);

  let h: number;
  if (max === rn) h = ((gn - bn) / delta + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / delta + 2) / 6;
  else h = ((rn - gn) / delta + 4) / 6;

  return { h: h * 360, s: s * 100, l: l * 100 };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const hn = ((h % 360) + 360) % 360 / 360;
  const sn = Math.min(100, Math.max(0, s)) / 100;
  const ln = Math.min(100, Math.max(0, l)) / 100;

  if (sn === 0) {
    const grey = Math.round(ln * 255);
    return { r: grey, g: grey, b: grey };
  }

  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
  const p = 2 * ln - q;

  const channel = (t: number): number => {
    let v = t;
    if (v < 0) v += 1;
    if (v > 1) v -= 1;
    if (v < 1 / 6) return p + (q - p) * 6 * v;
    if (v < 1 / 2) return q;
    if (v < 2 / 3) return p + (q - p) * (2 / 3 - v) * 6;
    return p;
  };

  return {
    r: Math.round(channel(hn + 1 / 3) * 255),
    g: Math.round(channel(hn) * 255),
    b: Math.round(channel(hn - 1 / 3) * 255),
  };
}

/** Hue, saturation and value, which is what a picker square works in. */
export function rgbToHsv({ r, g, b }: Rgb): { h: number; s: number; v: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === rn) h = ((gn - bn) / delta + (gn < bn ? 6 : 0)) / 6;
    else if (max === gn) h = ((bn - rn) / delta + 2) / 6;
    else h = ((rn - gn) / delta + 4) / 6;
  }
  return { h: h * 360, s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToRgb(h: number, s: number, v: number): Rgb {
  const hn = (((h % 360) + 360) % 360) / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hn % 2) - 1));
  const m = v - c;

  const [r, g, b] =
    hn < 1 ? [c, x, 0] :
    hn < 2 ? [x, c, 0] :
    hn < 3 ? [0, c, x] :
    hn < 4 ? [0, x, c] :
    hn < 5 ? [x, 0, c] : [c, 0, x];

  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}
