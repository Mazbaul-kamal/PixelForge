import { canEditLayer } from '../core/layer-ops';
import { captureLayerPixels, restoreLayerPixels } from '../core/snapshot';
import { StrokeEngine } from '../core/stroke-engine';
import type { BrushSettings } from '../core/stroke-engine';
import type { Layer, Point } from '../core/types';
import type { OptionSpec, ToolContext, ToolSample } from './types';

export const MIN_BRUSH_SIZE = 1;
export const MAX_BRUSH_SIZE = 2000;

/**
 * Shared machinery for every tool that paints a stroke into a buffer and then
 * composites it onto a layer: brush, eraser, and later clone stamp and smudge.
 * Option VALUES are stored per tool by the ToolManager, so two tools can share
 * this schema and still remember their own sizes.
 */
export function strokeOptions(overrides: Partial<Record<string, number>> = {}): OptionSpec[] {
  return [
    {
      type: 'number',
      id: 'size',
      label: 'Size',
      min: MIN_BRUSH_SIZE,
      max: MAX_BRUSH_SIZE,
      default: overrides['size'] ?? 24,
      unit: 'px',
    },
    { type: 'slider', id: 'hardness', label: 'Hardness', min: 0, max: 100, default: overrides['hardness'] ?? 100, unit: '%' },
    { type: 'slider', id: 'opacity', label: 'Opacity', min: 0, max: 100, default: overrides['opacity'] ?? 100, unit: '%' },
    { type: 'slider', id: 'flow', label: 'Flow', min: 1, max: 100, default: overrides['flow'] ?? 100, unit: '%' },
    { type: 'slider', id: 'spacing', label: 'Spacing', min: 1, max: 100, default: overrides['spacing'] ?? 12, unit: '%' },
    { type: 'slider', id: 'smoothing', label: 'Smoothing', min: 0, max: 100, default: overrides['smoothing'] ?? 20, unit: '%' },
    { type: 'checkbox', id: 'pressureSize', label: 'Pressure size', default: true },
    { type: 'checkbox', id: 'pressureOpacity', label: 'Pressure opacity', default: false },
  ];
}

export interface BrushSettingsOverrides {
  size?: number;
  hardness?: number;
  shape?: 'round' | 'square';
}

export function readBrushSettings(
  context: ToolContext,
  colour: string,
  overrides: BrushSettingsOverrides = {},
): BrushSettings {
  const options = context.options;
  const size = overrides.size ?? options.get<number>('size');

  return {
    size: Math.min(Math.max(size, MIN_BRUSH_SIZE), MAX_BRUSH_SIZE),
    hardness: overrides.hardness ?? options.get<number>('hardness') / 100,
    flow: options.get<number>('flow') / 100,
    spacing: options.get<number>('spacing') / 100,
    smoothing: options.get<number>('smoothing') / 100,
    pressureSize: options.get<boolean>('pressureSize'),
    pressureOpacity: options.get<boolean>('pressureOpacity'),
    shape: overrides.shape ?? 'round',
    colour,
  };
}

/**
 * Where a painting tool actually draws: the layer's pixels, or its mask.
 *
 * Tools ask for one of these and paint into it. Nothing inside a tool knows
 * which it got, so masks needed no special-casing anywhere.
 */
export interface PaintSurface {
  readonly layer: Layer;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly isMask: boolean;
}

export interface StrokeSession {
  readonly surface: PaintSurface;
  readonly buffer: HTMLCanvasElement;
  readonly bufferCtx: CanvasRenderingContext2D;
  readonly engine: StrokeEngine;
}

export function beginStrokeSession(surface: PaintSurface, settings: BrushSettings): StrokeSession {
  const buffer = document.createElement('canvas');
  buffer.width = surface.canvas.width;
  buffer.height = surface.canvas.height;

  const bufferCtx = buffer.getContext('2d');
  if (!bufferCtx) throw new Error('Could not acquire a 2D context for the stroke buffer.');

  return { surface, buffer, bufferCtx, engine: new StrokeEngine(bufferCtx, settings) };
}

/** The surface to paint on, or null when the layer refuses edits. */
export function paintableSurface(context: ToolContext): PaintSurface | null {
  const layer = context.activeLayer;
  if (!canEditLayer(layer) || !layer) return null;

  if (context.drawingTarget === 'mask' && layer.mask) {
    const ctx = layer.mask.getContext('2d');
    if (!ctx) return null;
    return { layer, canvas: layer.mask, ctx, isMask: true };
  }
  return { layer, canvas: layer.canvas, ctx: layer.ctx, isMask: false };
}

/** True when the layer can be painted on at all. */
export function paintableLayer(context: ToolContext): Layer | null {
  const layer = context.activeLayer;
  return canEditLayer(layer) ? layer : null;
}

/** Converts a pointer sample into the surface-local space the buffer uses. */
export function toBufferSample(sample: ToolSample, surface: PaintSurface | Layer) {
  const layer = 'layer' in surface ? surface.layer : surface;
  return { x: sample.doc.x - layer.x, y: sample.doc.y - layer.y, pressure: sample.pressure };
}

/**
 * Restricts a finished stroke buffer to the active selection.
 *
 * The buffer is the scratch surface SelectionMask.applyClip expects, so every
 * painting tool ends up going through that one function.
 */
export function clipBufferToSelection(session: StrokeSession, context: ToolContext): void {
  const selection = context.selection;
  if (!selection) return;
  selection.applyClip(session.bufferCtx, session.surface.layer.x, session.surface.layer.y);
}

/**
 * Clips the buffer, lets the caller apply it to the layer however it likes,
 * and records the whole thing as one history entry.
 */
export function commitStroke(
  context: ToolContext,
  session: StrokeSession,
  label: string,
  apply: (surfaceCtx: CanvasRenderingContext2D, buffer: HTMLCanvasElement) => void,
): void {
  clipBufferToSelection(session, context);
  context.setLiveStroke(null);

  if (!session.engine.hasPainted) {
    context.invalidateComposite();
    return;
  }

  const { surface } = session;
  const layer = surface.layer;
  const doc = context.doc;
  const target = surface.isMask ? 'mask' : 'layer';
  const before = captureLayerPixels(layer, target);

  apply(surface.ctx, session.buffer);

  const after = captureLayerPixels(layer, target);
  context.history.push(
    label,
    () => restoreLayerPixels(doc, before),
    () => restoreLayerPixels(doc, after),
  );
  context.invalidateComposite();
}

/** Steps a brush size proportionally, for the [ and ] shortcuts. */
export function stepBrushSize(context: ToolContext, direction: 1 | -1): void {
  const current = context.options.get<number>('size');
  const delta = Math.max(1, Math.round(current * 0.1));
  const next = current + delta * direction;
  context.options.set('size', Math.min(Math.max(next, MIN_BRUSH_SIZE), MAX_BRUSH_SIZE));
}

/** The true-size cursor, black under white so it reads on any image. */
export function drawCursorOutline(
  ctx: CanvasRenderingContext2D,
  centre: Point,
  radius: number,
  shape: 'round' | 'square',
): void {
  if (radius < 0.5) return;

  const path = (): void => {
    ctx.beginPath();
    if (shape === 'square') {
      ctx.rect(
        Math.round(centre.x - radius) + 0.5,
        Math.round(centre.y - radius) + 0.5,
        Math.round(radius * 2),
        Math.round(radius * 2),
      );
    } else {
      ctx.arc(centre.x, centre.y, radius, 0, Math.PI * 2);
    }
  };

  ctx.save();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
  path();
  ctx.stroke();

  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  path();
  ctx.stroke();
  ctx.restore();
}
