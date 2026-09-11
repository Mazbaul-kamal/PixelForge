import { hexToRgb } from './colour-utils';
export type AdjustmentKind =
  | 'brightness-contrast' | 'levels' | 'curves' | 'hue-saturation' | 'colour-balance'
  | 'black-white' | 'exposure' | 'vibrance' | 'photo-filter'
  | 'invert' | 'threshold' | 'posterize'
  | 'gradient-map' | 'selective-colour' | 'channel-mixer';

export type CurvePoint = readonly [number, number];

export interface AdjustmentParams {
  readonly [key: string]: number | string | boolean | readonly CurvePoint[] | undefined;
}

export interface AdjustmentData {
  readonly kind: AdjustmentKind;
  readonly params: AdjustmentParams;
}

const num = (params: AdjustmentParams, key: string, fallback: number): number => {
  const value = params[key];
  return typeof value === 'number' ? value : fallback;
};

const text = (params: AdjustmentParams, key: string, fallback: string): string => {
  const value = params[key];
  return typeof value === 'string' ? value : fallback;
};

const clamp255 = (value: number): number => (value < 0 ? 0 : value > 255 ? 255 : value);

/** A 256 entry ramp. Building one turns a per-pixel formula into a lookup. */
function buildLut(map: (input: number) => number): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = clamp255(map(i));
  return lut;
}

/**
 * A monotone cubic spline through the control points, sampled into a lookup.
 *
 * Monotone rather than natural: a plain cubic overshoots between close points
 * and puts wiggles into a curve the user drew as a smooth ramp.
 */
export function curveLut(points: readonly CurvePoint[]): Uint8ClampedArray {
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  if (sorted.length === 0) return buildLut((i) => i);
  if (sorted.length === 1) return buildLut(() => sorted[0]![1]);

  const xs = sorted.map((p) => p[0]);
  const ys = sorted.map((p) => p[1]);
  const n = xs.length;

  // Secant slopes, then Fritsch-Carlson tangents.
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = xs[i + 1]! - xs[i]!;
    slopes.push(dx === 0 ? 0 : (ys[i + 1]! - ys[i]!) / dx);
  }

  const tangents: number[] = new Array(n).fill(0);
  tangents[0] = slopes[0]!;
  tangents[n - 1] = slopes[n - 2]!;
  for (let i = 1; i < n - 1; i++) {
    if (slopes[i - 1]! * slopes[i]! <= 0) tangents[i] = 0;
    else tangents[i] = (slopes[i - 1]! + slopes[i]!) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (slopes[i] === 0) { tangents[i] = 0; tangents[i + 1] = 0; continue; }
    const a = tangents[i]! / slopes[i]!;
    const b = tangents[i + 1]! / slopes[i]!;
    const h = Math.hypot(a, b);
    if (h > 3) {
      tangents[i] = (3 / h) * a * slopes[i]!;
      tangents[i + 1] = (3 / h) * b * slopes[i]!;
    }
  }

  return buildLut((x) => {
    if (x <= xs[0]!) return ys[0]!;
    if (x >= xs[n - 1]!) return ys[n - 1]!;

    let i = 0;
    while (i < n - 2 && x > xs[i + 1]!) i++;

    const h = xs[i + 1]! - xs[i]!;
    if (h === 0) return ys[i]!;
    const t = (x - xs[i]!) / h;
    const t2 = t * t;
    const t3 = t2 * t;

    return (
      (2 * t3 - 3 * t2 + 1) * ys[i]! +
      (t3 - 2 * t2 + t) * h * tangents[i]! +
      (-2 * t3 + 3 * t2) * ys[i + 1]! +
      (t3 - t2) * h * tangents[i + 1]!
    );
  });
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    let v = t;
    if (v < 0) v += 1;
    if (v > 1) v -= 1;
    if (v < 1 / 6) return p + (q - p) * 6 * v;
    if (v < 1 / 2) return q;
    if (v < 2 / 3) return p + (q - p) * (2 / 3 - v) * 6;
    return p;
  };
  return [channel(h + 1 / 3) * 255, channel(h) * 255, channel(h - 1 / 3) * 255];
}

/** Which of the six colour ranges a hue belongs to, 0..1 weighted. */
function rangeWeight(hue: number, range: string): number {
  if (range === 'master') return 1;
  const centres: Record<string, number> = {
    reds: 0, yellows: 1 / 6, greens: 2 / 6, cyans: 3 / 6, blues: 4 / 6, magentas: 5 / 6,
  };
  const centre = centres[range];
  if (centre === undefined) return 1;

  let distance = Math.abs(hue - centre);
  if (distance > 0.5) distance = 1 - distance;
  // Full strength within 30 degrees, fading out by 60.
  const width = 1 / 12;
  if (distance <= width) return 1;
  if (distance >= width * 2) return 0;
  return 1 - (distance - width) / width;
}

export interface AdjustmentOperator {
  /** Transforms RGBA data in place. */
  readonly apply: (data: Uint8ClampedArray) => void;
}

/**
 * Builds the operator for an adjustment.
 *
 * Anything that maps each channel independently becomes a 256 entry lookup,
 * which makes Levels and Curves cost one array read per channel instead of a
 * function call and a handful of floating point operations per pixel.
 */
export function createAdjustment(adjustment: AdjustmentData): AdjustmentOperator {
  const { kind, params } = adjustment;

  const perChannelLut = (
    red: Uint8ClampedArray, green: Uint8ClampedArray, blue: Uint8ClampedArray,
  ): AdjustmentOperator => ({
    apply: (data) => {
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) continue;
        data[i] = red[data[i]!]!;
        data[i + 1] = green[data[i + 1]!]!;
        data[i + 2] = blue[data[i + 2]!]!;
      }
    },
  });

  const sameLut = (lut: Uint8ClampedArray) => perChannelLut(lut, lut, lut);

  switch (kind) {
    case 'brightness-contrast': {
      const brightness = num(params, 'brightness', 0);
      const contrast = num(params, 'contrast', 0);
      const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
      return sameLut(buildLut((i) => factor * (i + brightness - 128) + 128));
    }

    case 'levels': {
      const black = num(params, 'black', 0);
      const white = num(params, 'white', 255);
      const gamma = Math.max(0.01, num(params, 'gamma', 1));
      const outLow = num(params, 'outputLow', 0);
      const outHigh = num(params, 'outputHigh', 255);
      const span = Math.max(1, white - black);

      return sameLut(buildLut((i) => {
        const normalised = Math.min(1, Math.max(0, (i - black) / span));
        return outLow + (outHigh - outLow) * normalised ** (1 / gamma);
      }));
    }

    case 'curves': {
      const master = curveLut((params['rgb'] as CurvePoint[]) ?? [[0, 0], [255, 255]]);
      const perChannel = (key: string): Uint8ClampedArray => {
        const own = curveLut((params[key] as CurvePoint[]) ?? [[0, 0], [255, 255]]);
        // Channel curve first, then the master curve on top of it.
        return buildLut((i) => master[own[i]!]!);
      };
      return perChannelLut(perChannel('red'), perChannel('green'), perChannel('blue'));
    }

    case 'exposure': {
      const stops = num(params, 'exposure', 0);
      const offset = num(params, 'offset', 0);
      const gamma = Math.max(0.01, num(params, 'gamma', 1));
      const gain = 2 ** stops;
      return sameLut(buildLut((i) => 255 * ((i / 255) * gain + offset) ** (1 / gamma)));
    }

    case 'invert':
      return sameLut(buildLut((i) => 255 - i));

    case 'threshold': {
      const level = num(params, 'level', 128);
      return { apply: (data) => {
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] === 0) continue;
          const luma = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
          const value = luma >= level ? 255 : 0;
          data[i] = value; data[i + 1] = value; data[i + 2] = value;
        }
      } };
    }

    case 'gradient-map': {
      const shadow = hexToRgb(text(params, 'shadow', '#000000')) ?? { r: 0, g: 0, b: 0 };
      const highlight = hexToRgb(text(params, 'highlight', '#ffffff')) ?? { r: 255, g: 255, b: 255 };
      const midpoint = Math.min(0.95, Math.max(0.05, num(params, 'midpoint', 0.5)));
      const reverse = params.reverse === true;

      // One ramp per channel, indexed by luminance, so the whole thing is
      // three lookups and no arithmetic per pixel.
      const ramp = [0, 1, 2].map((channel) => {
        const from = channel === 0 ? shadow.r : channel === 1 ? shadow.g : shadow.b;
        const to = channel === 0 ? highlight.r : channel === 1 ? highlight.g : highlight.b;
        return buildLut((i) => {
          let t = i / 255;
          if (reverse) t = 1 - t;
          // The midpoint bends the ramp the way a gradient midpoint does.
          const shaped = Math.pow(t, Math.log(0.5) / Math.log(midpoint));
          return from + (to - from) * shaped;
        });
      });

      return { apply: (data) => {
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] === 0) continue;
          const luma = Math.round(
            0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!,
          );
          data[i] = ramp[0]![luma]!;
          data[i + 1] = ramp[1]![luma]!;
          data[i + 2] = ramp[2]![luma]!;
        }
      } };
    }

    case 'channel-mixer': {
      const output = text(params, 'output', 'red');
      const mono = params.monochrome === true;
      const wr = num(params, 'red', output === 'red' ? 100 : 0) / 100;
      const wg = num(params, 'green', output === 'green' ? 100 : 0) / 100;
      const wb = num(params, 'blue', output === 'blue' ? 100 : 0) / 100;
      const constant = (num(params, 'constant', 0) / 100) * 255;

      return { apply: (data) => {
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] === 0) continue;
          const mixed = data[i]! * wr + data[i + 1]! * wg + data[i + 2]! * wb + constant;
          if (mono) {
            const value = clamp255(mixed);
            data[i] = value; data[i + 1] = value; data[i + 2] = value;
          } else if (output === 'red') {
            data[i] = clamp255(mixed);
          } else if (output === 'green') {
            data[i + 1] = clamp255(mixed);
          } else {
            data[i + 2] = clamp255(mixed);
          }
        }
      } };
    }

    case 'selective-colour': {
      const range = text(params, 'range', 'reds');
      const relative = params.relative !== false;
      const cyan = num(params, 'cyan', 0) / 100;
      const magenta = num(params, 'magenta', 0) / 100;
      const yellow = num(params, 'yellow', 0) / 100;
      const black = num(params, 'black', 0) / 100;

      return { apply: (data) => {
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] === 0) continue;
          const r = data[i]! / 255;
          const g = data[i + 1]! / 255;
          const b = data[i + 2]! / 255;
          const weight = selectiveWeight(range, r, g, b);
          if (weight <= 0) continue;

          // Photoshop works in CMY here: more cyan means less red.
          const channels = [r, g, b];
          const deltas = [-cyan, -magenta, -yellow];
          for (let c = 0; c < 3; c += 1) {
            const value = channels[c]!;
            let next = relative
              ? value + value * deltas[c]! * weight
              : value + deltas[c]! * weight;
            // Black moves every channel toward zero together.
            next = relative ? next - next * black * weight : next - black * weight;
            data[i + c] = clamp255(next * 255);
          }
        }
      } };
    }

    case 'posterize': {
      const levels = Math.max(2, Math.round(num(params, 'levels', 6)));
      const step = 255 / (levels - 1);
      return sameLut(buildLut((i) => Math.round(Math.round(i / step) * step)));
    }

    case 'black-white': {
      const weights = {
        red: num(params, 'red', 0.3), yellow: num(params, 'yellow', 0.6),
        green: num(params, 'green', 0.4), cyan: num(params, 'cyan', 0.6),
        blue: num(params, 'blue', 0.2), magenta: num(params, 'magenta', 0.8),
      };
      return { apply: (data) => {
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] === 0) continue;
          const r = data[i]! / 255, g = data[i + 1]! / 255, b = data[i + 2]! / 255;
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          // Mix by how much of each primary and secondary the pixel contains.
          const grey =
            min +
            (max - min) * (
              r === max ? (g >= b ? weights.red * (1 - (g - min) / (max - min || 1)) + weights.yellow * ((g - min) / (max - min || 1))
                                  : weights.red * (1 - (b - min) / (max - min || 1)) + weights.magenta * ((b - min) / (max - min || 1)))
              : g === max ? (b >= r ? weights.green * (1 - (b - min) / (max - min || 1)) + weights.cyan * ((b - min) / (max - min || 1))
                                    : weights.green * (1 - (r - min) / (max - min || 1)) + weights.yellow * ((r - min) / (max - min || 1)))
              : (r >= g ? weights.blue * (1 - (r - min) / (max - min || 1)) + weights.magenta * ((r - min) / (max - min || 1))
                        : weights.blue * (1 - (g - min) / (max - min || 1)) + weights.cyan * ((g - min) / (max - min || 1)))
            );
          const value = clamp255(grey * 255);
          data[i] = value; data[i + 1] = value; data[i + 2] = value;
        }
      } };
    }

    case 'hue-saturation': {
      const hueShift = num(params, 'hue', 0) / 360;
      const saturation = num(params, 'saturation', 0) / 100;
      const lightness = num(params, 'lightness', 0) / 100;
      const range = text(params, 'range', 'master');

      return { apply: (data) => {
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] === 0) continue;
          const [h, s, l] = rgbToHsl(data[i]!, data[i + 1]!, data[i + 2]!);
          const weight = rangeWeight(h, range);
          if (weight === 0) continue;

          let nh = h + hueShift * weight;
          nh -= Math.floor(nh);
          const ns = Math.min(1, Math.max(0, s + saturation * weight * (saturation > 0 ? 1 - s : s)));
          const nl = Math.min(1, Math.max(0, l + lightness * weight * (lightness > 0 ? 1 - l : l)));

          const [r, g, b] = hslToRgb(nh, ns, nl);
          data[i] = r; data[i + 1] = g; data[i + 2] = b;
        }
      } };
    }

    case 'vibrance': {
      const vibrance = num(params, 'vibrance', 0) / 100;
      const saturation = num(params, 'saturation', 0) / 100;
      return { apply: (data) => {
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] === 0) continue;
          const [h, s, l] = rgbToHsl(data[i]!, data[i + 1]!, data[i + 2]!);
          // Vibrance leans on the least saturated pixels, which is what keeps
          // skin from going lurid while dull colours come up.
          const boosted = s + vibrance * (1 - s) * (1 - s) + saturation * (1 - s);
          const [r, g, b] = hslToRgb(h, Math.min(1, Math.max(0, boosted)), l);
          data[i] = r; data[i + 1] = g; data[i + 2] = b;
        }
      } };
    }

    case 'colour-balance': {
      const shadows: [number, number, number] = [
        num(params, 'shadowRed', 0), num(params, 'shadowGreen', 0), num(params, 'shadowBlue', 0),
      ];
      const mids: [number, number, number] = [
        num(params, 'midRed', 0), num(params, 'midGreen', 0), num(params, 'midBlue', 0),
      ];
      const highs: [number, number, number] = [
        num(params, 'highRed', 0), num(params, 'highGreen', 0), num(params, 'highBlue', 0),
      ];

      return { apply: (data) => {
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] === 0) continue;
          for (let c = 0; c < 3; c++) {
            const value = data[i + c]! / 255;
            const shadowWeight = (1 - value) * (1 - value);
            const highWeight = value * value;
            const midWeight = 1 - shadowWeight - highWeight;
            const shift =
              shadows[c]! * shadowWeight + mids[c]! * midWeight + highs[c]! * highWeight;
            data[i + c] = clamp255(data[i + c]! + shift);
          }
        }
      } };
    }

    case 'photo-filter': {
      const colour = text(params, 'colour', '#ec8a00');
      const density = num(params, 'density', 25) / 100;
      const preserveLuminosity = params['preserveLuminosity'] !== false;

      const r = parseInt(colour.slice(1, 3), 16);
      const g = parseInt(colour.slice(3, 5), 16);
      const b = parseInt(colour.slice(5, 7), 16);

      return { apply: (data) => {
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] === 0) continue;
          const before = 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;

          let nr = data[i]! * (1 - density) + ((data[i]! * r) / 255) * density;
          let ng = data[i + 1]! * (1 - density) + ((data[i + 1]! * g) / 255) * density;
          let nb = data[i + 2]! * (1 - density) + ((data[i + 2]! * b) / 255) * density;

          if (preserveLuminosity) {
            const after = 0.2126 * nr + 0.7152 * ng + 0.0722 * nb;
            const scale = after > 0.5 ? before / after : 1;
            nr *= scale; ng *= scale; nb *= scale;
          }
          data[i] = clamp255(nr); data[i + 1] = clamp255(ng); data[i + 2] = clamp255(nb);
        }
      } };
    }
  }
}

/** Sensible starting parameters for each adjustment. */
export function defaultParams(kind: AdjustmentKind): AdjustmentParams {
  switch (kind) {
    case 'brightness-contrast': return { brightness: 0, contrast: 0 };
    case 'levels': return { black: 0, white: 255, gamma: 1, outputLow: 0, outputHigh: 255 };
    case 'curves': return {
      rgb: [[0, 0], [255, 255]] as CurvePoint[],
      red: [[0, 0], [255, 255]] as CurvePoint[],
      green: [[0, 0], [255, 255]] as CurvePoint[],
      blue: [[0, 0], [255, 255]] as CurvePoint[],
    };
    case 'hue-saturation': return { hue: 0, saturation: 0, lightness: 0, range: 'master' };
    case 'colour-balance': return {
      shadowRed: 0, shadowGreen: 0, shadowBlue: 0,
      midRed: 0, midGreen: 0, midBlue: 0,
      highRed: 0, highGreen: 0, highBlue: 0,
    };
    case 'black-white': return { red: 0.3, yellow: 0.6, green: 0.4, cyan: 0.6, blue: 0.2, magenta: 0.8 };
    case 'exposure': return { exposure: 0, offset: 0, gamma: 1 };
    case 'vibrance': return { vibrance: 0, saturation: 0 };
    case 'photo-filter': return { colour: '#ec8a00', density: 25, preserveLuminosity: true };
    case 'invert': return {};
    case 'threshold': return { level: 128 };
    case 'posterize': return { levels: 6 };
    case 'gradient-map': return {
      shadow: '#1b2a4a', highlight: '#ffd9a0', midpoint: 0.5, reverse: false,
    };
    case 'channel-mixer': return {
      output: 'red', red: 100, green: 0, blue: 0, constant: 0, monochrome: false,
    };
    case 'selective-colour': return {
      range: 'reds', cyan: 0, magenta: 0, yellow: 0, black: 0, relative: true,
    };
  }
}

/**
 * How strongly a colour belongs to one of Photoshop's nine ranges.
 *
 * The six hue ranges use the standard trick: a pixel's membership is how much
 * its channels separate, so a pure red scores 1 and a grey scores 0. Whites,
 * neutrals and blacks are keyed off lightness instead.
 */
function selectiveWeight(range: string, r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const mid = r + g + b - max - min;

  switch (range) {
    case 'reds': return r === max ? Math.max(0, r - Math.max(g, b)) : 0;
    case 'greens': return g === max ? Math.max(0, g - Math.max(r, b)) : 0;
    case 'blues': return b === max ? Math.max(0, b - Math.max(r, g)) : 0;
    case 'cyans': return r === min ? Math.max(0, Math.min(g, b) - r) : 0;
    case 'magentas': return g === min ? Math.max(0, Math.min(r, b) - g) : 0;
    case 'yellows': return b === min ? Math.max(0, Math.min(r, g) - b) : 0;
    case 'whites': return Math.max(0, (min - 0.5) * 2);
    case 'blacks': return Math.max(0, (0.5 - max) * 2);
    case 'neutrals': {
      // Strongest for mid greys, fading out toward black, white and saturation.
      const chroma = max - min;
      return Math.max(0, (1 - chroma * 2)) * Math.max(0, 1 - Math.abs(mid - 0.5) * 2);
    }
    default: return 0;
  }
}

export const ADJUSTMENT_NAMES: Record<AdjustmentKind, string> = {
  'brightness-contrast': 'Brightness / Contrast',
  levels: 'Levels',
  curves: 'Curves',
  'hue-saturation': 'Hue / Saturation',
  'colour-balance': 'Colour Balance',
  'black-white': 'Black and White',
  exposure: 'Exposure',
  vibrance: 'Vibrance',
  'photo-filter': 'Photo Filter',
  invert: 'Invert',
  threshold: 'Threshold',
  posterize: 'Posterize',
  'gradient-map': 'Gradient Map',
  'selective-colour': 'Selective Colour',
  'channel-mixer': 'Channel Mixer',
};

/** Counts of each level, for the Levels histogram. */
export function histogram(data: Uint8ClampedArray): {
  red: Uint32Array; green: Uint32Array; blue: Uint32Array; luma: Uint32Array;
} {
  const red = new Uint32Array(256);
  const green = new Uint32Array(256);
  const blue = new Uint32Array(256);
  const luma = new Uint32Array(256);

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    red[data[i]!]!++;
    green[data[i + 1]!]!++;
    blue[data[i + 2]!]!++;
    luma[Math.round(0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!)]!++;
  }
  return { red, green, blue, luma };
}
