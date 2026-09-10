import { blendModeToComposite, BLEND_MODES } from '../core/types';
import type { BlendMode, Point } from '../core/types';
import {
  beginStrokeSession,
  commitStroke,
  drawCursorOutline,
  paintableSurface,
  readBrushSettings,
  stepBrushSize,
  strokeOptions,
  toBufferSample,
} from './stroke-tool';
import type { StrokeSession } from './stroke-tool';
import type { OptionSpec, Tool, ToolContext, ToolPointer } from './types';

function formatBlendMode(mode: BlendMode): string {
  return mode
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export const BLEND_MODE_OPTION: OptionSpec = {
  type: 'select',
  id: 'blendMode',
  label: 'Mode',
  default: 'normal',
  choices: BLEND_MODES.map((mode) => ({ value: mode, label: formatBlendMode(mode) })),
};

export function createBrushTool(): Tool {
  let session: StrokeSession | null = null;
  let hover: Point | null = null;

  const compositeOf = (context: ToolContext): GlobalCompositeOperation =>
    blendModeToComposite(context.options.get<string>('blendMode') as BlendMode);

  const showLive = (context: ToolContext, active: StrokeSession): void => {
    context.setLiveStroke({
      layerId: active.surface.layer.id,
      canvas: active.buffer,
      opacity: context.options.get<number>('opacity') / 100,
      composite: compositeOf(context),
      target: active.surface.isMask ? 'mask' : 'layer',
    });
  };

  return {
    id: 'brush',
    name: 'Brush',
    shortcut: 'B',
    // The ring is the cursor, so the system pointer gets out of the way.
    cursor: 'none',
    options: [...strokeOptions(), BLEND_MODE_OPTION],

    onPointerDown(context: ToolContext, pointer: ToolPointer): void {
      const surface = paintableSurface(context);
      if (!surface) return;

      session = beginStrokeSession(surface, readBrushSettings(context, context.colours.foreground));
      session.engine.begin(toBufferSample(pointer, surface));
      showLive(context, session);
      context.invalidateComposite();
    },

    onPointerMove(context: ToolContext, pointer: ToolPointer): void {
      hover = pointer.doc;

      const active = session;
      if (!active) {
        context.requestRender();
        return;
      }

      active.engine.update(readBrushSettings(context, context.colours.foreground));
      // Consume every coalesced sample: a high-refresh stylus reports several
      // per frame, and dropping them makes fast strokes look polygonal.
      for (const sample of pointer.coalesced) {
        active.engine.extend(toBufferSample(sample, active.surface));
      }

      showLive(context, active);
      // Only the tiles the new dabs covered need recompositing.
      const touched = active.engine.takeDirtyBounds();
      context.invalidateComposite(touched ? {
        x: touched.x + active.surface.layer.x,
        y: touched.y + active.surface.layer.y,
        width: touched.width,
        height: touched.height,
      } : undefined);
    },

    onPointerUp(context: ToolContext): void {
      const active = session;
      if (!active) return;
      session = null;

      active.engine.finish();
      const opacity = Math.min(Math.max(context.options.get<number>('opacity') / 100, 0), 1);
      const composite = compositeOf(context);

      // The buffer holds the whole stroke at full alpha, so opacity is applied
      // exactly once here. Stamping at opacity would darken self-overlaps.
      commitStroke(context, active, 'Brush Stroke', (surfaceCtx, buffer) => {
        surfaceCtx.save();
        surfaceCtx.globalAlpha = opacity;
        surfaceCtx.globalCompositeOperation = composite;
        surfaceCtx.drawImage(buffer, 0, 0);
        surfaceCtx.restore();
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
      session = null;
      context.setLiveStroke(null);
    },
  };
}
