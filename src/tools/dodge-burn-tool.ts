import {
  dabBox, dabCoverage, luminance, toneWeight, writeDabBox,
} from '../core/pixel-brush';
import type { ToneRange } from '../core/pixel-brush';
import { captureLayerPixels, restoreLayerPixels } from '../core/snapshot';
import { StrokeEngine } from '../core/stroke-engine';
import type { PixelSnapshot } from '../core/snapshot';
import type { Point } from '../core/types';
import {
  drawCursorOutline, paintableSurface, readBrushSettings, stepBrushSize, strokeOptions,
  toBufferSample,
} from './stroke-tool';
import type { PaintSurface } from './stroke-tool';
import type { Tool, ToolContext, ToolPointer } from './types';

export interface DodgeBurnDeps {
  onChanged: () => void;
}

/**
 * Dodge and burn. They differ only in direction, so both come from here.
 *
 * The adjustment is asymptotic — dodge moves each channel a fraction of the
 * way to white rather than adding a constant — so a bright area at low
 * exposure lightens gradually instead of clipping straight to white.
 */
export function createDodgeBurnTool(mode: 'dodge' | 'burn', deps: DodgeBurnDeps): Tool {
  let engine: StrokeEngine | null = null;
  let target: PaintSurface | null = null;
  let before: PixelSnapshot | null = null;
  let hover: Point | null = null;

  const finish = (context: ToolContext): void => {
    const surface = target;
    const start = before;
    const painted = engine?.hasPainted ?? false;
    engine = null;
    target = null;
    before = null;

    if (!surface || !start || !painted) return;

    const doc = context.doc;
    const after = captureLayerPixels(surface.layer, surface.isMask ? 'mask' : 'layer');
    context.history.push(
      mode === 'dodge' ? 'Dodge' : 'Burn',
      () => restoreLayerPixels(doc, start),
      () => restoreLayerPixels(doc, after),
    );
    deps.onChanged();
    context.invalidateComposite();
  };

  return {
    id: mode,
    name: mode === 'dodge' ? 'Dodge' : 'Burn',
    shortcut: 'O',
    cursor: 'none',

    options: [
      ...strokeOptions({ size: 60, hardness: 0 }),
      {
        type: 'select', id: 'range', label: 'Range', default: 'midtones',
        choices: [
          { value: 'shadows', label: 'Shadows' },
          { value: 'midtones', label: 'Midtones' },
          { value: 'highlights', label: 'Highlights' },
        ],
      },
      { type: 'slider', id: 'exposure', label: 'Exposure', min: 1, max: 100, default: 20, unit: '%' },
      { type: 'checkbox', id: 'protectTones', label: 'Protect tones', default: true },
    ],

    onPointerDown(context: ToolContext, pointer: ToolPointer): void {
      const surface = paintableSurface(context);
      if (!surface) return;

      target = surface;
      const layer = surface.layer;
      // One snapshot for the whole stroke, so it is a single undo even though
      // the pixels are written dab by dab.
      before = captureLayerPixels(layer, surface.isMask ? 'mask' : 'layer');

      const range = context.options.get<string>('range') as ToneRange;
      const exposure = context.options.get<number>('exposure') / 100;
      const protectTones = context.options.get<boolean>('protectTones');
      const hardness = context.options.get<number>('hardness') / 100;
      const selection = context.selection;

      engine = new StrokeEngine(surface.ctx, readBrushSettings(context, '#000000'));
      engine.onDab = (dab) => {
        const patch = dabBox(surface, dab);
        if (!patch) return;

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

            const i = (y * patch.width + x) * 4;
            const r = pixels[i]!;
            const g = pixels[i + 1]!;
            const b = pixels[i + 2]!;
            if (pixels[i + 3] === 0) continue;

            const light = luminance(r, g, b);
            const amount = exposure * coverage * toneWeight(range, light);
            if (amount <= 0) continue;

            if (protectTones) {
              // Scaling every channel by the same factor moves lightness
              // without dragging the hue. The scale is capped so the brightest
              // channel stops at 255 instead of clipping: once one channel
              // clamps and the others keep rising, the ratios collapse toward
              // grey, which is the colour shift this option exists to stop.
              const targetLight = mode === 'dodge'
                ? light + (1 - light) * amount
                : light * (1 - amount);
              const wanted = light <= 0.001 ? 1 + amount : targetLight / light;

              const brightest = Math.max(r, g, b);
              const ceiling = brightest > 0 ? 255 / brightest : 1;
              const scale = Math.min(wanted, ceiling);

              pixels[i] = r * scale;
              pixels[i + 1] = g * scale;
              pixels[i + 2] = b * scale;
              continue;
            }

            if (mode === 'dodge') {
              pixels[i] = r + (255 - r) * amount;
              pixels[i + 1] = g + (255 - g) * amount;
              pixels[i + 2] = b + (255 - b) * amount;
            } else {
              pixels[i] = r * (1 - amount);
              pixels[i + 1] = g * (1 - amount);
              pixels[i + 2] = b * (1 - amount);
            }
          }
        }
        writeDabBox(surface, patch);
      };

      engine.begin(toBufferSample(pointer, surface));
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
    },
  };
}
