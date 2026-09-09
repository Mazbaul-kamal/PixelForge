import { canEditLayer } from '../core/layer-ops';
import { captureLayerPixels, restoreLayerPixels } from '../core/snapshot';
import { StrokeEngine } from '../core/stroke-engine';
import type { BrushSettings } from '../core/stroke-engine';
import { BLEND_MODES } from '../core/types';
import type { BlendMode, Layer, Point } from '../core/types';
import type { OptionSpec, Tool, ToolContext, ToolPointer, ToolSample } from './types';

const MIN_SIZE = 1;
const MAX_SIZE = 2000;

function formatBlendMode(mode: BlendMode): string {
  return mode
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Options shared with the eraser and the other stroke tools. */
export const BRUSH_OPTIONS: readonly OptionSpec[] = [
  { type: 'number', id: 'size', label: 'Size', min: MIN_SIZE, max: MAX_SIZE, default: 24, unit: 'px' },
  { type: 'slider', id: 'hardness', label: 'Hardness', min: 0, max: 100, default: 100, unit: '%' },
  { type: 'slider', id: 'opacity', label: 'Opacity', min: 0, max: 100, default: 100, unit: '%' },
  { type: 'slider', id: 'flow', label: 'Flow', min: 1, max: 100, default: 100, unit: '%' },
  { type: 'slider', id: 'spacing', label: 'Spacing', min: 1, max: 100, default: 12, unit: '%' },
  { type: 'slider', id: 'smoothing', label: 'Smoothing', min: 0, max: 100, default: 20, unit: '%' },
  { type: 'checkbox', id: 'pressureSize', label: 'Pressure size', default: true },
  { type: 'checkbox', id: 'pressureOpacity', label: 'Pressure opacity', default: false },
  {
    type: 'select',
    id: 'blendMode',
    label: 'Mode',
    default: 'normal',
    choices: BLEND_MODES.map((mode) => ({ value: mode, label: formatBlendMode(mode) })),
  },
];

export function readBrushSettings(context: ToolContext, colour: string): BrushSettings {
  const options = context.options;
  return {
    size: Math.min(Math.max(options.get<number>('size'), MIN_SIZE), MAX_SIZE),
    hardness: options.get<number>('hardness') / 100,
    flow: options.get<number>('flow') / 100,
    spacing: options.get<number>('spacing') / 100,
    smoothing: options.get<number>('smoothing') / 100,
    pressureSize: options.get<boolean>('pressureSize'),
    pressureOpacity: options.get<boolean>('pressureOpacity'),
    colour,
  };
}

/** Everything a stroke tool needs in flight, shared with the eraser later. */
export interface StrokeSession {
  readonly layer: Layer;
  readonly buffer: HTMLCanvasElement;
  readonly bufferCtx: CanvasRenderingContext2D;
  readonly engine: StrokeEngine;
}

export function beginStrokeSession(layer: Layer, settings: BrushSettings): StrokeSession {
  const buffer = document.createElement('canvas');
  buffer.width = layer.canvas.width;
  buffer.height = layer.canvas.height;

  const bufferCtx = buffer.getContext('2d');
  if (!bufferCtx) throw new Error('Could not acquire a 2D context for the stroke buffer.');

  return { layer, buffer, bufferCtx, engine: new StrokeEngine(bufferCtx, settings) };
}

/** Restricts a finished stroke buffer to the active selection. */
export function clipBufferToSelection(session: StrokeSession, context: ToolContext): void {
  const selection = context.selection;
  if (!selection) return;

  const { bufferCtx, layer } = session;
  bufferCtx.save();
  bufferCtx.globalCompositeOperation = 'destination-in';
  bufferCtx.drawImage(selection.canvas, -layer.x, -layer.y);
  bufferCtx.restore();
}

export function createBrushTool(): Tool {
  let session: StrokeSession | null = null;
  let hover: Point | null = null;

  const settingsFor = (context: ToolContext): BrushSettings =>
    readBrushSettings(context, context.colours.foreground);

  const toBuffer = (sample: ToolSample, layer: Layer) => ({
    x: sample.doc.x - layer.x,
    y: sample.doc.y - layer.y,
    pressure: sample.pressure,
  });

  const showLive = (context: ToolContext): void => {
    if (!session) return;
    context.setLiveStroke({
      layerId: session.layer.id,
      canvas: session.buffer,
      opacity: context.options.get<number>('opacity') / 100,
      blendMode: context.options.get<string>('blendMode') as BlendMode,
    });
  };

  const cancel = (context: ToolContext): void => {
    session = null;
    context.setLiveStroke(null);
  };

  return {
    id: 'brush',
    name: 'Brush',
    shortcut: 'B',
    // The ring is the cursor, so the pointer itself gets out of the way.
    cursor: 'none',
    options: BRUSH_OPTIONS,

    onPointerDown(context: ToolContext, pointer: ToolPointer): void {
      const layer = context.activeLayer;
      if (!canEditLayer(layer) || !layer) return;

      session = beginStrokeSession(layer, settingsFor(context));
      session.engine.begin(toBuffer(pointer, layer));
      showLive(context);
      context.invalidateComposite();
    },

    onPointerMove(context: ToolContext, pointer: ToolPointer): void {
      hover = pointer.doc;

      if (!session) {
        context.requestRender();
        return;
      }

      session.engine.update(settingsFor(context));
      // Consume every coalesced sample: a 240Hz stylus reports several per
      // frame, and dropping them is what makes fast strokes look polygonal.
      for (const sample of pointer.coalesced) {
        session.engine.extend(toBuffer(sample, session.layer));
      }

      showLive(context);
      context.invalidateComposite();
    },

    onPointerUp(context: ToolContext): void {
      const active = session;
      if (!active) return;
      session = null;

      active.engine.finish();
      clipBufferToSelection(active, context);
      context.setLiveStroke(null);

      if (!active.engine.hasPainted) {
        context.invalidateComposite();
        return;
      }

      const layer = active.layer;
      const doc = context.doc;
      const before = captureLayerPixels(layer);

      // The buffer holds the whole stroke at full alpha, so opacity is applied
      // exactly once here. Stamping at opacity would darken self-overlaps.
      layer.ctx.save();
      layer.ctx.globalAlpha = Math.min(Math.max(context.options.get<number>('opacity') / 100, 0), 1);
      layer.ctx.globalCompositeOperation =
        context.options.get<string>('blendMode') === 'normal'
          ? 'source-over'
          : (context.options.get<string>('blendMode') as GlobalCompositeOperation);
      layer.ctx.drawImage(active.buffer, 0, 0);
      layer.ctx.restore();

      const after = captureLayerPixels(layer);
      context.history.push(
        'Brush Stroke',
        () => restoreLayerPixels(doc, before),
        () => restoreLayerPixels(doc, after),
      );
      context.invalidateComposite();
    },

    onKeyDown(context: ToolContext, event: KeyboardEvent): boolean {
      if (event.key !== '[' && event.key !== ']') return false;

      const current = context.options.get<number>('size');
      // Step proportionally so the shortcut stays useful at both extremes.
      const delta = Math.max(1, Math.round(current * 0.1));
      const next = event.key === ']' ? current + delta : current - delta;

      context.options.set('size', Math.min(Math.max(next, MIN_SIZE), MAX_SIZE));
      context.requestRender();
      return true;
    },

    drawOverlay(ctx: CanvasRenderingContext2D, context: ToolContext): void {
      if (!hover) return;

      const centre = context.viewport.docToScreen(hover.x, hover.y);
      const radius = (context.options.get<number>('size') / 2) * context.viewport.zoom;
      if (radius < 0.5) return;

      // Black under white, so the ring reads on any image beneath it.
      ctx.save();
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, radius, 0, Math.PI * 2);
      ctx.stroke();

      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    },

    deactivate(context: ToolContext): void {
      hover = null;
      cancel(context);
    },
  };
}
