import { hexToRgb, rgbToHex } from './colour-utils';
import { defaultStyles } from './layer-styles';
import type { LayerStyles } from './layer-styles';
import { blendModeFromPsd, blendModeToPsd } from './psd-blend-modes';
import type { BlendMode } from './types';

interface PsdColour { r: number; g: number; b: number }
interface PsdUnits { units: string; value: number }

/** ag-psd's effects bag, narrowed to the parts that map onto our styles. */
export interface PsdEffects {
  dropShadow?: PsdShadow[];
  innerShadow?: PsdShadow[];
  outerGlow?: PsdGlow;
  innerGlow?: PsdGlow;
  stroke?: PsdStroke[];
  solidFill?: PsdSolidFill[];
  gradientOverlay?: PsdGradientOverlay[];
  disabled?: boolean;
}

interface PsdShadow {
  enabled?: boolean; color?: PsdColour; opacity?: number; blendMode?: string;
  angle?: number; distance?: PsdUnits; size?: PsdUnits; choke?: PsdUnits;
}
interface PsdGlow {
  enabled?: boolean; color?: PsdColour; opacity?: number; blendMode?: string;
  size?: PsdUnits; choke?: PsdUnits;
}
interface PsdStroke {
  enabled?: boolean; color?: PsdColour; opacity?: number; blendMode?: string;
  size?: PsdUnits; position?: 'inside' | 'center' | 'outside';
}
interface PsdSolidFill {
  enabled?: boolean; color?: PsdColour; opacity?: number; blendMode?: string;
}
interface PsdGradientOverlay {
  enabled?: boolean; opacity?: number; blendMode?: string; angle?: number; scale?: number;
  reverse?: boolean;
}

const px = (value: number): PsdUnits => ({ units: 'Pixels', value });

/**
 * Spread as PSD stores it.
 *
 * Photoshop shows spread and choke as a percentage of the size, but the file
 * holds a length and ag-psd rejects anything but a length unit here, so the
 * fraction is written as the pixels it works out to.
 */
const chokeOf = (spread: number, size: number): PsdUnits => px(spread * size);

/** The inverse, tolerant of a file that did store a percentage. */
function spreadOf(choke: PsdUnits | undefined, size: number): number {
  if (!choke || typeof choke.value !== 'number') return 0;
  if (choke.units === 'Percent') return Math.min(1, Math.max(0, choke.value / 100));
  if (size <= 0) return 0;
  return Math.min(1, Math.max(0, choke.value / size));
}

function toPsdColour(hex: string): PsdColour {
  const rgb = hexToRgb(hex) ?? { r: 0, g: 0, b: 0 };
  return { r: rgb.r, g: rgb.g, b: rgb.b };
}

function fromPsdColour(colour: PsdColour | undefined, fallback: string): string {
  if (!colour) return fallback;
  return rgbToHex({
    r: Math.round(colour.r), g: Math.round(colour.g), b: Math.round(colour.b),
  });
}

const unitValue = (value: PsdUnits | undefined, fallback: number): number =>
  (typeof value?.value === 'number' ? value.value : fallback);

/**
 * Our effects as PSD effects.
 *
 * Photoshop's model is close but not identical — its spread and choke are
 * percentages of the size, and it has no midpoint on a gradient overlay — so
 * this is the interoperable approximation. The exact values travel in the XMP
 * sidecar and win when the file is reopened here.
 */
export function stylesToPsdEffects(styles: LayerStyles, enabled: boolean): PsdEffects | undefined {
  const effects: PsdEffects = {};
  let any = false;

  if (styles.dropShadow.enabled) {
    const s = styles.dropShadow;
    effects.dropShadow = [{
      enabled: true, color: toPsdColour(s.colour), opacity: s.opacity,
      blendMode: blendModeToPsd(s.blendMode), angle: s.angle,
      distance: px(s.distance), size: px(s.size), choke: chokeOf(s.spread, s.size),
    }];
    any = true;
  }

  if (styles.innerShadow.enabled) {
    const s = styles.innerShadow;
    effects.innerShadow = [{
      enabled: true, color: toPsdColour(s.colour), opacity: s.opacity,
      blendMode: blendModeToPsd(s.blendMode), angle: s.angle,
      distance: px(s.distance), size: px(s.size), choke: chokeOf(s.spread, s.size),
    }];
    any = true;
  }

  if (styles.outerGlow.enabled) {
    const s = styles.outerGlow;
    effects.outerGlow = {
      enabled: true, color: toPsdColour(s.colour), opacity: s.opacity,
      blendMode: blendModeToPsd(s.blendMode), size: px(s.size), choke: chokeOf(s.spread, s.size),
    };
    any = true;
  }

  if (styles.innerGlow.enabled) {
    const s = styles.innerGlow;
    effects.innerGlow = {
      enabled: true, color: toPsdColour(s.colour), opacity: s.opacity,
      blendMode: blendModeToPsd(s.blendMode), size: px(s.size), choke: chokeOf(s.spread, s.size),
    };
    any = true;
  }

  if (styles.stroke.enabled) {
    const s = styles.stroke;
    effects.stroke = [{
      enabled: true, color: toPsdColour(s.colour), opacity: s.opacity,
      blendMode: blendModeToPsd(s.blendMode), size: px(s.size),
      position: s.position === 'centre' ? 'center' : s.position,
    }];
    any = true;
  }

  if (styles.colourOverlay.enabled) {
    const s = styles.colourOverlay;
    effects.solidFill = [{
      enabled: true, color: toPsdColour(s.colour), opacity: s.opacity,
      blendMode: blendModeToPsd(s.blendMode),
    }];
    any = true;
  }

  if (styles.gradientOverlay.enabled) {
    const s = styles.gradientOverlay;
    effects.gradientOverlay = [{
      enabled: true, opacity: s.opacity, blendMode: blendModeToPsd(s.blendMode),
      angle: s.angle, scale: s.scale * 100, reverse: s.reverse,
    }];
    any = true;
  }

  if (!any) return undefined;
  if (!enabled) effects.disabled = true;
  return effects;
}

const blend = (mode: string | undefined, fallback: BlendMode): BlendMode =>
  (mode ? blendModeFromPsd(mode).mode : fallback);

/** PSD effects as ours, for a file this editor did not write. */
export function psdEffectsToStyles(effects: PsdEffects): LayerStyles | null {
  const styles = defaultStyles();
  let any = false;

  const shadow = effects.dropShadow?.[0];
  if (shadow && shadow.enabled !== false) {
    styles.dropShadow = {
      ...styles.dropShadow, enabled: true,
      colour: fromPsdColour(shadow.color, '#000000'),
      opacity: shadow.opacity ?? 0.35,
      blendMode: blend(shadow.blendMode, 'multiply'),
      angle: shadow.angle ?? 120,
      distance: unitValue(shadow.distance, 5),
      size: unitValue(shadow.size, 5),
      spread: spreadOf(shadow.choke, unitValue(shadow.size, 5)),
    };
    any = true;
  }

  const inner = effects.innerShadow?.[0];
  if (inner && inner.enabled !== false) {
    styles.innerShadow = {
      ...styles.innerShadow, enabled: true,
      colour: fromPsdColour(inner.color, '#000000'),
      opacity: inner.opacity ?? 0.35,
      blendMode: blend(inner.blendMode, 'multiply'),
      angle: inner.angle ?? 120,
      distance: unitValue(inner.distance, 5),
      size: unitValue(inner.size, 5),
      spread: spreadOf(inner.choke, unitValue(inner.size, 5)),
    };
    any = true;
  }

  if (effects.outerGlow && effects.outerGlow.enabled !== false) {
    const glow = effects.outerGlow;
    styles.outerGlow = {
      ...styles.outerGlow, enabled: true,
      colour: fromPsdColour(glow.color, '#ffe08a'),
      opacity: glow.opacity ?? 0.5,
      blendMode: blend(glow.blendMode, 'screen'),
      size: unitValue(glow.size, 8),
      spread: spreadOf(glow.choke, unitValue(glow.size, 8)),
    };
    any = true;
  }

  if (effects.innerGlow && effects.innerGlow.enabled !== false) {
    const glow = effects.innerGlow;
    styles.innerGlow = {
      ...styles.innerGlow, enabled: true,
      colour: fromPsdColour(glow.color, '#ffe08a'),
      opacity: glow.opacity ?? 0.5,
      blendMode: blend(glow.blendMode, 'screen'),
      size: unitValue(glow.size, 8),
      spread: spreadOf(glow.choke, unitValue(glow.size, 8)),
    };
    any = true;
  }

  const stroke = effects.stroke?.[0];
  if (stroke && stroke.enabled !== false) {
    styles.stroke = {
      ...styles.stroke, enabled: true,
      colour: fromPsdColour(stroke.color, '#000000'),
      opacity: stroke.opacity ?? 1,
      blendMode: blend(stroke.blendMode, 'normal'),
      size: unitValue(stroke.size, 3),
      position: stroke.position === 'center' ? 'centre' : (stroke.position ?? 'outside'),
    };
    any = true;
  }

  const fill = effects.solidFill?.[0];
  if (fill && fill.enabled !== false) {
    styles.colourOverlay = {
      ...styles.colourOverlay, enabled: true,
      colour: fromPsdColour(fill.color, '#c8102e'),
      opacity: fill.opacity ?? 1,
      blendMode: blend(fill.blendMode, 'normal'),
    };
    any = true;
  }

  const gradient = effects.gradientOverlay?.[0];
  if (gradient && gradient.enabled !== false) {
    styles.gradientOverlay = {
      ...styles.gradientOverlay, enabled: true,
      opacity: gradient.opacity ?? 1,
      blendMode: blend(gradient.blendMode, 'normal'),
      angle: gradient.angle ?? 90,
      scale: (typeof gradient.scale === 'number' ? gradient.scale : 100) / 100,
      reverse: gradient.reverse === true,
    };
    any = true;
  }

  return any ? styles : null;
}
