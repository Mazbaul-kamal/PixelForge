export type GradientType = 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond';

/** 'FG' and 'BG' resolve to the live foreground and background colours. */
export type StopColour = string;

export interface ColourStop {
  position: number;
  colour: StopColour;
}

export interface OpacityStop {
  position: number;
  /** 0..1 */
  opacity: number;
}

export interface GradientDefinition {
  id: string;
  name: string;
  colourStops: ColourStop[];
  opacityStops: OpacityStop[];
  /**
   * Where the blend is half way between each pair of adjacent colour stops,
   * as a fraction of that segment. 0.5 is an even blend.
   */
  midpoints: number[];
}

export interface GradientGeometry {
  readonly startX: number;
  readonly startY: number;
  readonly endX: number;
  readonly endY: number;
}

export interface RenderOptions {
  readonly type: GradientType;
  readonly reverse: boolean;
  readonly dither: boolean;
  /** When false the gradient is drawn fully opaque, ignoring opacity stops. */
  readonly transparency: boolean;
  readonly foreground: string;
  readonly background: string;
}

const LUT_SIZE = 1024;

/** Ordered dither. A Bayer matrix breaks banding without looking like noise. */
const BAYER_8 = buildBayer(8);

function buildBayer(size: number): Float32Array {
  const matrix = new Float32Array(size * size);
  const bits = Math.log2(size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Standard construction: consume coordinate bits from the top down,
      // appending two threshold bits per level. Taking them from the bottom
      // up produces a permutation that no longer disperses.
      let value = 0;
      for (let i = bits - 1; i >= 0; i--) {
        const xi = (x >> i) & 1;
        const yi = (y >> i) & 1;
        value = (value << 2) | ((xi ^ yi) << 1) | yi;
      }
      matrix[y * size + x] = value / (size * size);
    }
  }
  return matrix;
}

function parseColour(colour: StopColour, options: RenderOptions): [number, number, number] {
  const resolved =
    colour === 'FG' ? options.foreground : colour === 'BG' ? options.background : colour;

  if (resolved.startsWith('#') && resolved.length === 7) {
    return [
      parseInt(resolved.slice(1, 3), 16),
      parseInt(resolved.slice(3, 5), 16),
      parseInt(resolved.slice(5, 7), 16),
    ];
  }
  if (resolved.startsWith('#') && resolved.length === 4) {
    const r = resolved[1]!;
    const g = resolved[2]!;
    const b = resolved[3]!;
    return [parseInt(r + r, 16), parseInt(g + g, 16), parseInt(b + b, 16)];
  }
  return [0, 0, 0];
}

/** Skews a segment so the blend reaches half way at the midpoint. */
function applyMidpoint(t: number, midpoint: number): number {
  const m = Math.min(0.95, Math.max(0.05, midpoint));
  return t <= m ? 0.5 * (t / m) : 0.5 + 0.5 * ((t - m) / (1 - m));
}

/**
 * Expands the stops into a high resolution lookup of float RGBA. Rendering
 * then costs one lookup per pixel, and dithering can be applied before the
 * values are rounded to 8 bits.
 */
export function buildGradientLut(
  definition: GradientDefinition,
  options: RenderOptions,
): Float32Array {
  const lut = new Float32Array(LUT_SIZE * 4);

  const colours = [...definition.colourStops].sort((a, b) => a.position - b.position);
  const alphas = [...definition.opacityStops].sort((a, b) => a.position - b.position);
  if (colours.length === 0) return lut;

  for (let i = 0; i < LUT_SIZE; i++) {
    const raw = i / (LUT_SIZE - 1);
    const t = options.reverse ? 1 - raw : raw;

    // Colour
    let lower = colours[0]!;
    let upper = colours[colours.length - 1]!;
    let segment = -1;
    for (let s = 0; s < colours.length - 1; s++) {
      if (t >= colours[s]!.position && t <= colours[s + 1]!.position) {
        lower = colours[s]!;
        upper = colours[s + 1]!;
        segment = s;
        break;
      }
    }

    let local = 0;
    if (segment >= 0) {
      const span = upper.position - lower.position;
      local = span <= 0 ? 0 : (t - lower.position) / span;
      local = applyMidpoint(local, definition.midpoints[segment] ?? 0.5);
    } else {
      lower = upper = t < colours[0]!.position ? colours[0]! : colours[colours.length - 1]!;
    }

    const from = parseColour(lower.colour, options);
    const to = parseColour(upper.colour, options);

    // Opacity
    let alpha = 1;
    if (options.transparency && alphas.length > 0) {
      alpha = alphas[alphas.length - 1]!.opacity;
      if (t <= alphas[0]!.position) alpha = alphas[0]!.opacity;
      else {
        for (let s = 0; s < alphas.length - 1; s++) {
          const a = alphas[s]!;
          const b = alphas[s + 1]!;
          if (t >= a.position && t <= b.position) {
            const span = b.position - a.position;
            const k = span <= 0 ? 0 : (t - a.position) / span;
            alpha = a.opacity + (b.opacity - a.opacity) * k;
            break;
          }
        }
      }
    }

    const offset = i * 4;
    lut[offset] = from[0] + (to[0] - from[0]) * local;
    lut[offset + 1] = from[1] + (to[1] - from[1]) * local;
    lut[offset + 2] = from[2] + (to[2] - from[2]) * local;
    lut[offset + 3] = alpha * 255;
  }
  return lut;
}

/** Position along the gradient, 0..1, for the chosen type. */
function parameterAt(
  type: GradientType,
  x: number,
  y: number,
  geometry: GradientGeometry,
): number {
  const dx = geometry.endX - geometry.startX;
  const dy = geometry.endY - geometry.startY;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return 0;

  const px = x - geometry.startX;
  const py = y - geometry.startY;

  switch (type) {
    case 'linear':
      return (px * dx + py * dy) / lengthSquared;
    case 'reflected':
      return Math.abs((px * dx + py * dy) / lengthSquared);
    case 'radial':
      return Math.sqrt((px * px + py * py) / lengthSquared);
    case 'angle': {
      const angle = Math.atan2(py, px) - Math.atan2(dy, dx);
      const turns = angle / (Math.PI * 2);
      return turns - Math.floor(turns);
    }
    case 'diamond': {
      const length = Math.sqrt(lengthSquared);
      const ux = dx / length;
      const uy = dy / length;
      // Distance measured along the axis and across it, added together.
      const along = px * ux + py * uy;
      const across = -px * uy + py * ux;
      return (Math.abs(along) + Math.abs(across)) / length;
    }
  }
}

/**
 * Renders a gradient into an RGBA buffer.
 *
 * Every type goes through the same per-pixel path rather than using the canvas
 * primitives for some of them: reflected and diamond have no canvas
 * equivalent, and ordered dithering has to happen before the colour is rounded
 * to 8 bits, which a canvas gradient gives no chance to do.
 */
export function renderGradient(
  target: ImageData,
  definition: GradientDefinition,
  geometry: GradientGeometry,
  options: RenderOptions,
): void {
  const lut = buildGradientLut(definition, options);
  const { width, height, data } = target;
  const lastIndex = LUT_SIZE - 1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let t = parameterAt(options.type, x + 0.5, y + 0.5, geometry);
      if (t < 0) t = 0;
      else if (t > 1) t = 1;

      const source = Math.round(t * lastIndex) * 4;
      const offset = (y * width + x) * 4;

      // Ordered dither: a sub-LSB offset before rounding, which removes the
      // banding an 8-bit ramp shows across a wide area.
      const noise = options.dither ? BAYER_8[(y & 7) * 8 + (x & 7)]! - 0.5 : 0;

      data[offset] = Math.round(lut[source]! + noise);
      data[offset + 1] = Math.round(lut[source + 1]! + noise);
      data[offset + 2] = Math.round(lut[source + 2]! + noise);
      data[offset + 3] = Math.round(lut[source + 3]!);
    }
  }
}

function stop(position: number, colour: string): ColourStop {
  return { position, colour };
}

const FULL_OPACITY: OpacityStop[] = [
  { position: 0, opacity: 1 },
  { position: 1, opacity: 1 },
];

/** Presets, including the two that follow the current colours. */
export function gradientPresets(): GradientDefinition[] {
  return [
    {
      id: 'fg-bg', name: 'Foreground to background',
      colourStops: [stop(0, 'FG'), stop(1, 'BG')],
      opacityStops: [...FULL_OPACITY], midpoints: [0.5],
    },
    {
      id: 'fg-transparent', name: 'Foreground to transparent',
      colourStops: [stop(0, 'FG'), stop(1, 'FG')],
      opacityStops: [{ position: 0, opacity: 1 }, { position: 1, opacity: 0 }],
      midpoints: [0.5],
    },
    {
      id: 'black-white', name: 'Black to white',
      colourStops: [stop(0, '#000000'), stop(1, '#ffffff')],
      opacityStops: [...FULL_OPACITY], midpoints: [0.5],
    },
    {
      id: 'white-black', name: 'White to black',
      colourStops: [stop(0, '#ffffff'), stop(1, '#000000')],
      opacityStops: [...FULL_OPACITY], midpoints: [0.5],
    },
    {
      id: 'sunset', name: 'Sunset',
      colourStops: [stop(0, '#2b1055'), stop(0.45, '#c1436d'), stop(0.75, '#f5843c'), stop(1, '#ffd79a')],
      opacityStops: [...FULL_OPACITY], midpoints: [0.5, 0.5, 0.5],
    },
    {
      id: 'ocean', name: 'Ocean',
      colourStops: [stop(0, '#022c43'), stop(0.5, '#118ab2'), stop(1, '#8ee3ef')],
      opacityStops: [...FULL_OPACITY], midpoints: [0.5, 0.5],
    },
    {
      id: 'spectrum', name: 'Spectrum',
      colourStops: [
        stop(0, '#ff0000'), stop(0.17, '#ffff00'), stop(0.33, '#00ff00'),
        stop(0.5, '#00ffff'), stop(0.67, '#0000ff'), stop(0.83, '#ff00ff'), stop(1, '#ff0000'),
      ],
      opacityStops: [...FULL_OPACITY], midpoints: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
    },
    {
      id: 'fade-out', name: 'Transparent fade',
      colourStops: [stop(0, '#ffffff'), stop(1, '#ffffff')],
      opacityStops: [
        { position: 0, opacity: 0 }, { position: 0.5, opacity: 1 }, { position: 1, opacity: 0 },
      ],
      midpoints: [0.5],
    },
  ];
}

export function cloneGradient(definition: GradientDefinition): GradientDefinition {
  return {
    id: definition.id,
    name: definition.name,
    colourStops: definition.colourStops.map((s) => ({ ...s })),
    opacityStops: definition.opacityStops.map((s) => ({ ...s })),
    midpoints: [...definition.midpoints],
  };
}
