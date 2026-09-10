import type { BlendMode } from './types';

/**
 * PSD blend mode names to ours.
 *
 * Photoshop has more modes than canvas can express. Anything missing here is
 * reported rather than quietly drawn as Normal, so an import that cannot be
 * reproduced faithfully says so.
 */
const FROM_PSD: Record<string, BlendMode> = {
  normal: 'normal',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  'color dodge': 'color-dodge',
  'color burn': 'color-burn',
  'hard light': 'hard-light',
  'soft light': 'soft-light',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
};

const TO_PSD: Record<BlendMode, string> = {
  normal: 'normal',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  'color-dodge': 'color dodge',
  'color-burn': 'color burn',
  'hard-light': 'hard light',
  'soft-light': 'soft light',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
};

export interface BlendModeResult {
  readonly mode: BlendMode;
  /** Set when the PSD used a mode with no canvas equivalent. */
  readonly unsupported?: string;
}

export function blendModeFromPsd(name: string | undefined): BlendModeResult {
  if (!name) return { mode: 'normal' };

  const normalised = name.trim().toLowerCase();
  const mapped = FROM_PSD[normalised];
  if (mapped) return { mode: mapped };

  // Falls back to Normal, but the caller is told which mode was lost.
  return { mode: 'normal', unsupported: name };
}

export function blendModeToPsd(mode: BlendMode): string {
  return TO_PSD[mode] ?? 'normal';
}
