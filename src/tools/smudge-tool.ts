import { dabBox, dabCoverage, writeDabBox } from '../core/pixel-brush';
import { hexToRgb } from '../core/colour-utils';
import { captureLayerPixels, restoreLayerPixels } from '../core/snapshot';
import { StrokeEngine } from '../core/stroke-engine';
import type { PixelSnapshot } from '../core/snapshot';
import type { Layer, Point } from '../core/types';
import {
  drawCursorOutline, paintableLayer, readBrushSettings, stepBrushSize, strokeOptions,
  toBufferSample,
} from './stroke-tool';
import type { Tool, ToolContext, ToolPointer } from './types';

export interface SmudgeDeps {
  onChanged: () => void;
}

/**
 * Smudge drags colour along the stroke.
 *
 * A sample buffer rides the brush: each dab blends the buffer into the layer
 * at the strength setting, then takes the layer back into the buffer. At
 * strength 100 the buffer never refreshes, so one colour is dragged
 * indefinitely; at 0 nothing moves at all.
 */
export function createSmudgeTool(deps: SmudgeDeps): Tool {
  let engine: StrokeEngine | null = null;
  let target: Layer | null = null;
  let before: PixelSnapshot | null = null;
  let hover: Point | null = null;

  /** RGBA carried between dabs, indexed in dab-local coordinates. */
  let buffer: Float32Array | null = null;
  let bufferSize = 0;

  const ensureBuffer = (size: number, seed: [number, number, number] | null): void => {
    if (!buffer || bufferSize !== size) {
      buffer = new Float32Array(size * size * 4);
      bufferSize = size;
      if (seed) {
        for (let i = 0; i < buffer.length; i += 4) {
          buffer[i] = seed[0];
          buffer[i + 1] = seed[1];
          buffer[i + 2] = seed[2];
          buffer[i + 3] = 255;
        }
      }
    }
  };

  const finish = (context: ToolContext): void => {
    const layer = target;
    const start = before;
    const painted = engine?.hasPainted ?? false;
    engine = null;
    target = null;
    before = null;
    buffer = null;
    bufferSize = 0;

    if (!layer || !start || !painted) return;

    const doc = context.doc;
    const after = captureLayerPixels(layer);
    context.history.push(
      'Smudge',
      () => restoreLayerPixels(doc, start),
      () => restoreLayerPixels(doc, after),
    );
    deps.onChanged();
    context.invalidateComposite();
  };

  return {
    id: 'smudge',
    name: 'Smudge',
    shortcut: 'R',
    cursor: 'none',

    options: [
      ...strokeOptions({ size: 50, hardness: 0, spacing: 8 }),
      { type: 'slider', id: 'strength', label: 'Strength', min: 0, max: 100, default: 55, unit: '%' },
      { type: 'checkbox', id: 'fingerPainting', label: 'Finger painting', default: false },
    ],

    onPointerDown(context: ToolContext, pointer: ToolPointer): void {
      const layer = paintableLayer(context);
      if (!layer) return;

      target = layer;
      before = captureLayerPixels(layer);
      buffer = null;
      bufferSize = 0;

      const strength = context.options.get<number>('strength') / 100;
      const hardness = context.options.get<number>('hardness') / 100;
      const selection = context.selection;

      // Finger painting starts the buffer loaded with the foreground colour.
      const seedColour = context.options.get<boolean>('fingerPainting')
        ? hexToRgb(context.colours.foreground)
        : null;
      const seed: [number, number, number] | null =
        seedColour ? [seedColour.r, seedColour.g, seedColour.b] : null;

      engine = new StrokeEngine(layer.ctx, readBrushSettings(context, '#000000'));
      engine.onDab = (dab) => {
        if (strength <= 0) return;

        const patch = dabBox(layer, dab);
        if (!patch) return;

        const size = Math.max(1, Math.ceil(dab.radius) * 2 + 3);
        ensureBuffer(size, seed);
        if (!buffer) return;

        const half = (size - 1) / 2;
        const pixels = patch.image.data;

        for (let y = 0; y < patch.height; y++) {
          for (let x = 0; x < patch.width; x++) {
            const px = patch.left + x;
            const py = patch.top + y;
            let coverage = dabCoverage(dab, hardness, px, py);
            if (coverage <= 0) continue;

            if (selection) {
              coverage *= selection.valueAt(px + layer.x, py + layer.y) / 255;
              if (coverage <= 0) continue;
            }

            // Where this pixel sits inside the buffer that rides the brush.
            const bx = Math.round(px + 0.5 - dab.x + half);
            const by = Math.round(py + 0.5 - dab.y + half);
            if (bx < 0 || by < 0 || bx >= size || by >= size) continue;

            const b = (by * size + bx) * 4;
            const i = (y * patch.width + x) * 4;

            if (buffer[b + 3] === 0 && !seed) {
              // First contact: prime the buffer from the layer.
              buffer[b] = pixels[i]!;
              buffer[b + 1] = pixels[i + 1]!;
              buffer[b + 2] = pixels[i + 2]!;
              buffer[b + 3] = Math.max(1, pixels[i + 3]!);
            }

            const pull = strength * coverage;
            for (let c = 0; c < 4; c++) {
              const destination = pixels[i + c]!;
              const carried = buffer[b + c]!;
              const blended = destination + (carried - destination) * pull;
              pixels[i + c] = blended;
              // Re-sample: at full strength the buffer keeps its colour.
              buffer[b + c] = carried + (blended - carried) * (1 - strength) * coverage;
            }
          }
        }
        writeDabBox(layer, patch);
      };

      engine.begin(toBufferSample(pointer, layer));
      context.invalidateComposite();
    },

    onPointerMove(context: ToolContext, pointer: ToolPointer): void {
      hover = pointer.doc;
      if (!engine || !target) {
        context.requestRender();
        return;
      }
      engine.update(readBrushSettings(context, '#000000'));
      for (const sample of pointer.coalesced) engine.extend(toBufferSample(sample, target));
      context.invalidateComposite();
    },

    onPointerUp(context: ToolContext): void {
      engine?.finish();
      finish(context);
    },

    onKeyDown(context: ToolContext, event: KeyboardEvent): boolean {
      if (event.key !== '[' && event.key !== ']') return false;
      stepBrushSize(context, event.key === ']' ? 1 : -1);
      context.requestRender();
      return true;
    },

    drawOverlay(ctx: CanvasRenderingContext2D, context: ToolContext): void {
      if (!hover) return;
      const centre = context.viewport.docToScreen(hover.x, hover.y);
      drawCursorOutline(
        ctx, centre, (context.options.get<number>('size') / 2) * context.viewport.zoom, 'round',
      );
    },

    deactivate(): void {
      hover = null;
      engine = null;
      target = null;
      before = null;
      buffer = null;
    },
  };
}
