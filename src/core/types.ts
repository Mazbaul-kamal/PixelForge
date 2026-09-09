/** Core data shapes for PixelForge. Nothing in here touches the DOM beyond canvases. */

/**
 * The 16 blend modes we support. These are the canvas globalCompositeOperation
 * blending values; 'normal' is spelled 'source-over' by the canvas API, so it is
 * translated in `blendModeToComposite()` rather than stored that way.
 */
export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

export const BLEND_MODES: readonly BlendMode[] = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
];

export function blendModeToComposite(mode: BlendMode): GlobalCompositeOperation {
  return mode === 'normal' ? 'source-over' : mode;
}

import type { TextLayerData } from './text-layer';

/** Raster is the only kind step 1 creates; the others are produced by later steps. */
export type LayerType = 'raster' | 'text' | 'shape' | 'adjustment';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Layer {
  readonly id: string;
  name: string;
  /** Own bitmap. May be smaller than the document; it sits at (x, y). */
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  x: number;
  y: number;
  /** 0..1 */
  opacity: number;
  blendMode: BlendMode;
  visible: boolean;
  locked: boolean;
  type: LayerType;
  /** Layer mask bitmap. Applied by the mask engine in a later step. */
  mask?: HTMLCanvasElement;
  /**
   * Set on text layers. The bitmap is only a render of this, so the string and
   * its style stay editable. Immutable: edits replace the whole object.
   */
  text?: TextLayerData;
}
