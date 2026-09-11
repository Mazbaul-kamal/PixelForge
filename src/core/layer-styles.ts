import type { GradientDefinition, GradientType } from './gradient';
import { gradientPresets, renderGradient } from './gradient';
import type { BlendMode, Layer } from './types';
import { blendModeToComposite } from './types';

export interface ShadowStyle {
  enabled: boolean;
  colour: string;
  /** 0..1 */
  opacity: number;
  /** Degrees, measured the way Photoshop does: 0 is from the right. */
  angle: number;
  distance: number;
  /** 0..1 of the size, how much the silhouette grows before it is blurred. */
  spread: number;
  size: number;
  blendMode: BlendMode;
}

export interface GlowStyle {
  enabled: boolean;
  colour: string;
  opacity: number;
  spread: number;
  size: number;
  blendMode: BlendMode;
}

export interface StrokeStyle {
  enabled: boolean;
  colour: string;
  opacity: number;
  size: number;
  position: 'inside' | 'centre' | 'outside';
  blendMode: BlendMode;
}

export interface ColourOverlayStyle {
  enabled: boolean;
  colour: string;
  opacity: number;
  blendMode: BlendMode;
}

export interface GradientOverlayStyle {
  enabled: boolean;
  gradient: GradientDefinition;
  type: GradientType;
  angle: number;
  /** 0.1..3, how far the gradient is stretched across the layer. */
  scale: number;
  opacity: number;
  reverse: boolean;
  blendMode: BlendMode;
}

/**
 * The effects attached to a layer. Immutable: an edit replaces the whole
 * object, which is what lets the compositor cache a rendered result by
 * identity and lets history hold one by reference.
 */
export interface LayerStyles {
  dropShadow: ShadowStyle;
  outerGlow: GlowStyle;
  colourOverlay: ColourOverlayStyle;
  gradientOverlay: GradientOverlayStyle;
  innerGlow: GlowStyle;
  innerShadow: ShadowStyle;
  stroke: StrokeStyle;
}

export type StyleKey = keyof LayerStyles;

export const STYLE_NAMES: Record<StyleKey, string> = {
  dropShadow: 'Drop Shadow',
  outerGlow: 'Outer Glow',
  colourOverlay: 'Colour Overlay',
  gradientOverlay: 'Gradient Overlay',
  innerGlow: 'Inner Glow',
  innerShadow: 'Inner Shadow',
  stroke: 'Stroke',
};

/** Bottom to top, the order Photoshop composites effects in. */
export const STYLE_ORDER: StyleKey[] = [
  'dropShadow', 'outerGlow', 'colourOverlay', 'gradientOverlay',
  'innerGlow', 'innerShadow', 'stroke',
];

export function defaultStyles(): LayerStyles {
  return {
    dropShadow: {
      enabled: false, colour: '#000000', opacity: 0.35, angle: 120,
      distance: 5, spread: 0, size: 5, blendMode: 'multiply',
    },
    outerGlow: {
      enabled: false, colour: '#ffe08a', opacity: 0.5, spread: 0, size: 8, blendMode: 'screen',
    },
    colourOverlay: {
      enabled: false, colour: '#c8102e', opacity: 1, blendMode: 'normal',
    },
    gradientOverlay: {
      enabled: false, gradient: gradientPresets()[0]!, type: 'linear',
      angle: 90, scale: 1, opacity: 1, reverse: false, blendMode: 'normal',
    },
    innerGlow: {
      enabled: false, colour: '#ffe08a', opacity: 0.5, spread: 0, size: 8, blendMode: 'screen',
    },
    innerShadow: {
      enabled: false, colour: '#000000', opacity: 0.35, angle: 120,
      distance: 5, spread: 0, size: 5, blendMode: 'multiply',
    },
    stroke: {
      enabled: false, colour: '#000000', opacity: 1, size: 3,
      position: 'outside', blendMode: 'normal',
    },
  };
}

export function cloneStyles(styles: LayerStyles): LayerStyles {
  return {
    dropShadow: { ...styles.dropShadow },
    outerGlow: { ...styles.outerGlow },
    colourOverlay: { ...styles.colourOverlay },
    gradientOverlay: {
      ...styles.gradientOverlay,
      gradient: {
        ...styles.gradientOverlay.gradient,
        colourStops: styles.gradientOverlay.gradient.colourStops.map((s) => ({ ...s })),
        opacityStops: styles.gradientOverlay.gradient.opacityStops.map((s) => ({ ...s })),
      },
    },
    innerGlow: { ...styles.innerGlow },
    innerShadow: { ...styles.innerShadow },
    stroke: { ...styles.stroke },
  };
}

export function hasActiveStyles(layer: Layer): boolean {
  const styles = layer.styles;
  if (!styles || layer.stylesEnabled === false) return false;
  return STYLE_ORDER.some((key) => styles[key].enabled);
}

/** Effects that sit behind the layer and so must blend with the real backdrop. */
export function hasBackdropStyles(layer: Layer): boolean {
  const styles = layer.styles;
  if (!styles || layer.stylesEnabled === false) return false;
  return styles.dropShadow.enabled || styles.outerGlow.enabled;
}

/** How far past the layer's own bounds the effects can reach. */
export function styleExtent(styles: LayerStyles): number {
  let extent = 0;
  if (styles.dropShadow.enabled) {
    const s = styles.dropShadow;
    extent = Math.max(extent, Math.abs(s.distance) + s.size + s.size * s.spread);
  }
  if (styles.outerGlow.enabled) {
    extent = Math.max(extent, styles.outerGlow.size * (1 + styles.outerGlow.spread));
  }
  if (styles.stroke.enabled && styles.stroke.position !== 'inside') {
    extent = Math.max(extent, styles.stroke.position === 'outside'
      ? styles.stroke.size : styles.stroke.size / 2);
  }
  return Math.ceil(extent) + 2;
}

function scratch(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not acquire a 2D context for a layer effect.');
  return { canvas, ctx };
}

/** Offsets on a circle, used to grow or shrink an alpha silhouette. */
function ring(radius: number): Array<[number, number]> {
  if (radius <= 0) return [[0, 0]];
  const steps = Math.max(8, Math.min(32, Math.ceil(radius * 4)));
  const points: Array<[number, number]> = [[0, 0]];
  for (let i = 0; i < steps; i += 1) {
    const t = (i / steps) * Math.PI * 2;
    points.push([Math.cos(t) * radius, Math.sin(t) * radius]);
  }
  return points;
}

/** Union of the silhouette shifted around a circle: a cheap dilation. */
function dilate(source: HTMLCanvasElement, radius: number): HTMLCanvasElement {
  if (radius <= 0) return source;
  const { canvas, ctx } = scratch(source.width, source.height);
  for (const [dx, dy] of ring(radius)) ctx.drawImage(source, dx, dy);
  return canvas;
}

/** Intersection of the silhouette shifted around a circle: an erosion. */
function erode(source: HTMLCanvasElement, radius: number): HTMLCanvasElement {
  const { canvas, ctx } = scratch(source.width, source.height);
  ctx.drawImage(source, 0, 0);
  if (radius <= 0) return canvas;
  ctx.globalCompositeOperation = 'destination-in';
  for (const [dx, dy] of ring(radius)) ctx.drawImage(source, dx, dy);
  return canvas;
}

/** The source's alpha channel, flooded with one colour. */
function silhouette(source: HTMLCanvasElement, colour: string): HTMLCanvasElement {
  const { canvas, ctx } = scratch(source.width, source.height);
  ctx.drawImage(source, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return canvas;
}

function blur(source: HTMLCanvasElement, radius: number): HTMLCanvasElement {
  if (radius <= 0) return source;
  const { canvas, ctx } = scratch(source.width, source.height);
  ctx.filter = `blur(${radius}px)`;
  ctx.drawImage(source, 0, 0);
  return canvas;
}

/** A shadow or glow body: grow by the spread, then soften by the rest. */
function spreadAndBlur(source: HTMLCanvasElement, size: number, spread: number): HTMLCanvasElement {
  const grow = size * Math.min(Math.max(spread, 0), 1);
  const soften = Math.max(0, size - grow);
  return blur(dilate(source, grow), soften / 2);
}

/** The padded canvas holding the layer, positioned so effects have room. */
export interface StyledSurface {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
}

/** One effect that has to blend against the document, not against the layer. */
export interface BackdropEffect {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
  opacity: number;
  blendMode: BlendMode;
}

export interface StyledLayer {
  /** Drawn first, in order, each against the real backdrop. */
  behind: BackdropEffect[];
  /** The layer itself with its interior effects baked in. */
  surface: StyledSurface;
}

function offsetOf(angle: number, distance: number): [number, number] {
  const radians = (angle * Math.PI) / 180;
  return [Math.cos(radians) * distance, -Math.sin(radians) * distance];
}

/**
 * Renders a layer's effects.
 *
 * Interior effects — the overlays, the inner shadow and glow, the stroke —
 * blend against the layer itself, so they are baked into one padded surface.
 * The drop shadow and outer glow sit behind the layer and have to blend with
 * whatever is under it, so they come back separately for the compositor to
 * draw first.
 */
export function renderLayerStyles(
  base: HTMLCanvasElement,
  x: number,
  y: number,
  styles: LayerStyles,
): StyledLayer {
  const pad = styleExtent(styles);
  const width = base.width + pad * 2;
  const height = base.height + pad * 2;

  const padded = scratch(width, height);
  padded.ctx.drawImage(base, pad, pad);
  const alpha = padded.canvas;

  const behind: BackdropEffect[] = [];

  if (styles.dropShadow.enabled) {
    const s = styles.dropShadow;
    const [dx, dy] = offsetOf(s.angle, s.distance);
    const body = scratch(width, height);
    body.ctx.drawImage(spreadAndBlur(silhouette(alpha, s.colour), s.size, s.spread), dx, dy);
    // The layer knocks its own shadow out, so a translucent layer does not
    // show its shadow through itself.
    body.ctx.globalCompositeOperation = 'destination-out';
    body.ctx.drawImage(alpha, 0, 0);
    behind.push({
      canvas: body.canvas, x: x - pad, y: y - pad,
      opacity: s.opacity, blendMode: s.blendMode,
    });
  }

  if (styles.outerGlow.enabled) {
    const s = styles.outerGlow;
    const body = scratch(width, height);
    body.ctx.drawImage(spreadAndBlur(silhouette(alpha, s.colour), s.size, s.spread), 0, 0);
    body.ctx.globalCompositeOperation = 'destination-out';
    body.ctx.drawImage(alpha, 0, 0);
    behind.push({
      canvas: body.canvas, x: x - pad, y: y - pad,
      opacity: s.opacity, blendMode: s.blendMode,
    });
  }

  const surface = scratch(width, height);
  surface.ctx.drawImage(alpha, 0, 0);

  const clipToLayer = (body: HTMLCanvasElement): HTMLCanvasElement => {
    const clipped = scratch(width, height);
    clipped.ctx.drawImage(body, 0, 0);
    clipped.ctx.globalCompositeOperation = 'destination-in';
    clipped.ctx.drawImage(alpha, 0, 0);
    return clipped.canvas;
  };

  const stamp = (body: HTMLCanvasElement, opacity: number, mode: BlendMode): void => {
    surface.ctx.globalAlpha = Math.min(Math.max(opacity, 0), 1);
    surface.ctx.globalCompositeOperation = blendModeToComposite(mode);
    surface.ctx.drawImage(body, 0, 0);
    surface.ctx.globalAlpha = 1;
    surface.ctx.globalCompositeOperation = 'source-over';
  };

  if (styles.colourOverlay.enabled) {
    const s = styles.colourOverlay;
    stamp(silhouette(alpha, s.colour), s.opacity, s.blendMode);
  }

  if (styles.gradientOverlay.enabled) {
    const s = styles.gradientOverlay;
    const body = scratch(width, height);
    const radians = (s.angle * Math.PI) / 180;
    const reach = (Math.max(width, height) / 2) * Math.min(Math.max(s.scale, 0.1), 3);
    const cx = width / 2;
    const cy = height / 2;
    const image = body.ctx.createImageData(width, height);
    renderGradient(image, s.gradient, {
      startX: cx - Math.cos(radians) * reach,
      startY: cy + Math.sin(radians) * reach,
      endX: cx + Math.cos(radians) * reach,
      endY: cy - Math.sin(radians) * reach,
    }, {
      type: s.type, reverse: s.reverse, dither: true, transparency: true,
      foreground: '#000000', background: '#ffffff',
    });
    body.ctx.putImageData(image, 0, 0);
    stamp(clipToLayer(body.canvas), s.opacity, s.blendMode);
  }

  if (styles.innerGlow.enabled) {
    const s = styles.innerGlow;
    // The glow grows inward from the edge, so it starts from everything the
    // layer is NOT and is then trimmed back to the layer.
    const hole = scratch(width, height);
    hole.ctx.fillStyle = s.colour;
    hole.ctx.fillRect(0, 0, width, height);
    hole.ctx.globalCompositeOperation = 'destination-out';
    hole.ctx.drawImage(alpha, 0, 0);
    stamp(clipToLayer(spreadAndBlur(hole.canvas, s.size, s.spread)), s.opacity, s.blendMode);
  }

  if (styles.innerShadow.enabled) {
    const s = styles.innerShadow;
    const [dx, dy] = offsetOf(s.angle, s.distance);
    const hole = scratch(width, height);
    hole.ctx.fillStyle = s.colour;
    hole.ctx.fillRect(0, 0, width, height);
    hole.ctx.globalCompositeOperation = 'destination-out';
    hole.ctx.drawImage(alpha, dx, dy);
    stamp(clipToLayer(spreadAndBlur(hole.canvas, s.size, s.spread)), s.opacity, s.blendMode);
  }

  if (styles.stroke.enabled) {
    const s = styles.stroke;
    const band = scratch(width, height);
    if (s.position === 'outside') {
      band.ctx.drawImage(dilate(alpha, s.size), 0, 0);
      band.ctx.globalCompositeOperation = 'destination-out';
      band.ctx.drawImage(alpha, 0, 0);
    } else if (s.position === 'inside') {
      band.ctx.drawImage(alpha, 0, 0);
      band.ctx.globalCompositeOperation = 'destination-out';
      band.ctx.drawImage(erode(alpha, s.size), 0, 0);
    } else {
      band.ctx.drawImage(dilate(alpha, s.size / 2), 0, 0);
      band.ctx.globalCompositeOperation = 'destination-out';
      band.ctx.drawImage(erode(alpha, s.size / 2), 0, 0);
    }
    band.ctx.globalCompositeOperation = 'source-in';
    band.ctx.fillStyle = s.colour;
    band.ctx.fillRect(0, 0, width, height);
    stamp(band.canvas, s.opacity, s.blendMode);
  }

  return { behind, surface: { canvas: surface.canvas, x: x - pad, y: y - pad } };
}
