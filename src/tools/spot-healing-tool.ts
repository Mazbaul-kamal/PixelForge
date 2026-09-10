import { healRegion, MAX_HEAL_PIXELS } from '../core/heal';
import { captureLayerPixels, restoreLayerPixels } from '../core/snapshot';
import { StrokeEngine } from '../core/stroke-engine';
import type { Layer, Point } from '../core/types';
import {
  drawCursorOutline, paintableLayer, readBrushSettings, stepBrushSize, strokeOptions,
  toBufferSample,
} from './stroke-tool';
import type { Tool, ToolContext, ToolPointer } from './types';

export interface HealDeps {
  onChanged: () => void;
  notify: (title: string, detail?: string) => void;
  warn: (title: string, detail?: string) => void;
  track: <T>(label: string, work: Promise<T>) => Promise<T>;
}

/**
 * Spot healing. The stroke marks the region; the repair happens on pointer up,
 * borrowing texture from nearby and then solving a smooth correction field so
 * the borrowed patch takes on the surrounding colour and leaves no edge.
 */
export function createSpotHealingTool(deps: HealDeps): Tool {
  let engine: StrokeEngine | null = null;
  let maskCanvas: HTMLCanvasElement | null = null;
  let target: Layer | null = null;
  let hover: Point | null = null;

  const reset = (context: ToolContext): void => {
    engine = null;
    maskCanvas = null;
    target = null;
    context.setLiveStroke(null);
  };

  return {
    id: 'spot-healing',
    name: 'Spot Healing',
    shortcut: 'J',
    cursor: 'none',

    options: [
      ...strokeOptions({ size: 40, hardness: 100 }),
      { type: 'slider', id: 'iterations', label: 'Blend', min: 40, max: 600, default: 220 },
    ],

    onPointerDown(context: ToolContext, pointer: ToolPointer): void {
      const layer = paintableLayer(context);
      if (!layer) return;

      target = layer;
      maskCanvas = document.createElement('canvas');
      maskCanvas.width = layer.canvas.width;
      maskCanvas.height = layer.canvas.height;

      const ctx = maskCanvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;

      // The mask is painted with the ordinary brush machinery, so a soft edge
      // gives a partial blend rather than a hard patch boundary.
      engine = new StrokeEngine(ctx, readBrushSettings(context, '#ffffff'));
      engine.begin(toBufferSample(pointer, layer));

      context.setLiveStroke({
        layerId: layer.id,
        canvas: maskCanvas,
        opacity: 0.35,
        composite: 'source-over',
      });
      context.invalidateComposite();
    },

    onPointerMove(context: ToolContext, pointer: ToolPointer): void {
      hover = pointer.doc;
      if (!engine || !target) {
        context.requestRender();
        return;
      }

      engine.update(readBrushSettings(context, '#ffffff'));
      for (const sample of pointer.coalesced) engine.extend(toBufferSample(sample, target));
      context.invalidateComposite();
    },

    onPointerUp(context: ToolContext): void {
      const layer = target;
      const mask = maskCanvas;
      const painted = engine?.hasPainted ?? false;
      engine?.finish();
      reset(context);

      if (!layer || !mask || !painted) {
        context.invalidateComposite();
        return;
      }

      const maskCtx = mask.getContext('2d', { willReadFrequently: true });
      if (!maskCtx) return;

      const coverage = maskCtx.getImageData(0, 0, mask.width, mask.height);
      const alpha = new Uint8ClampedArray(mask.width * mask.height);
      let marked = 0;
      for (let i = 0, p = 3; i < alpha.length; i++, p += 4) {
        alpha[i] = coverage.data[p]!;
        if (alpha[i]! >= 128) marked++;
      }

      if (marked === 0) {
        context.invalidateComposite();
        return;
      }
      if (marked > MAX_HEAL_PIXELS) {
        deps.warn(
          'That area is too large to heal.',
          `Spot healing works on blemishes: ${marked.toLocaleString()} pixels were marked, and the ` +
            `limit is ${MAX_HEAL_PIXELS.toLocaleString()}. Try several smaller dabs.`,
        );
        context.invalidateComposite();
        return;
      }

      const layerCtx = layer.ctx;
      const source = layerCtx.getImageData(0, 0, layer.canvas.width, layer.canvas.height);
      const iterations = context.options.get<number>('iterations');

      const work = new Promise<ReturnType<typeof healRegion>>((resolve) => {
        // Yield a frame first so the busy badge can appear on a slow repair.
        requestAnimationFrame(() => {
          resolve(healRegion({
            pixels: source.data,
            width: source.width,
            height: source.height,
            mask: alpha,
            iterations,
          }));
        });
      });

      void deps.track('Healing…', work).then((result) => {
        if (!result) {
          context.invalidateComposite();
          return;
        }

        const doc = context.doc;
        const before = captureLayerPixels(layer);
        // Written back through the ImageData we already have, which avoids
        // constructing one from a buffer whose type cannot be narrowed.
        source.data.set(result.pixels);
        layerCtx.putImageData(source, 0, 0);

        const after = captureLayerPixels(layer);
        context.history.push(
          'Spot Healing',
          () => restoreLayerPixels(doc, before),
          () => restoreLayerPixels(doc, after),
        );
        deps.onChanged();
        context.invalidateComposite();
      });
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
      const radius = (context.options.get<number>('size') / 2) * context.viewport.zoom;
      drawCursorOutline(ctx, centre, radius, 'round');
    },

    deactivate(context: ToolContext): void {
      hover = null;
      reset(context);
    },
  };
}
