import { captureLayerPixels } from '../core/snapshot';
import type { PixelSnapshot } from '../core/snapshot';
import type { Layer, Point } from '../core/types';
import {
  beginStrokeSession,
  commitStroke,
  drawCursorOutline,
  paintableLayer,
  readBrushSettings,
  stepBrushSize,
  strokeOptions,
  toBufferSample,
} from './stroke-tool';
import type { BrushSettingsOverrides, StrokeSession } from './stroke-tool';
import type { Tool, ToolContext, ToolPointer } from './types';

/** The block eraser is a fixed on-screen square, whatever the zoom. */
const BLOCK_SCREEN_PX = 16;

type EraserMode = 'brush' | 'block';

/**
 * The eraser is the brush with a different way of applying its buffer.
 *
 * It shares the stroke engine and every helper in stroke-tool.ts; only the
 * final composite differs. Because the ToolManager keeps option values per
 * tool, the eraser remembers its own size, hardness, opacity and flow
 * independently of the Brush.
 */
export function createEraserTool(): Tool {
  let session: StrokeSession | null = null;
  let hover: Point | null = null;
  /** Whether this stroke restores pixels rather than removing them. */
  let restoring = false;

  /**
   * The layer as it stood when the eraser was picked up. Alt+erase paints from
   * this, so you can rub back to the state before you started erasing.
   */
  let checkpoint: PixelSnapshot | null = null;
  let checkpointLayerId: string | null = null;

  const modeOf = (context: ToolContext): EraserMode =>
    context.options.get<string>('mode') as EraserMode;

  /** In block mode the dab is a hard square of constant screen size. */
  const overridesFor = (context: ToolContext): BrushSettingsOverrides =>
    modeOf(context) === 'block'
      ? { size: BLOCK_SCREEN_PX / context.viewport.zoom, hardness: 1, shape: 'square' }
      : {};

  const refreshCheckpoint = (context: ToolContext): void => {
    const layer = context.activeLayer;
    if (!layer) {
      checkpoint = null;
      checkpointLayerId = null;
      return;
    }
    if (checkpointLayerId === layer.id) return;
    checkpoint = captureLayerPixels(layer);
    checkpointLayerId = layer.id;
  };

  const settingsFor = (context: ToolContext): ReturnType<typeof readBrushSettings> => {
    // The paint colour only matters when erasing to the background colour or
    // restoring history; otherwise the buffer is a pure alpha mask.
    const colour = context.options.get<boolean>('eraseToBackground')
      ? context.colours.background
      : '#000000';
    return readBrushSettings(context, colour, overridesFor(context));
  };

  const compositeFor = (context: ToolContext): GlobalCompositeOperation =>
    context.options.get<boolean>('eraseToBackground') ? 'source-over' : 'destination-out';

  const showLive = (context: ToolContext, active: StrokeSession): void => {
    context.setLiveStroke({
      layerId: active.layer.id,
      canvas: active.buffer,
      opacity: context.options.get<number>('opacity') / 100,
      // A restoring stroke has no honest live preview, because the pixels it
      // brings back are not in the buffer; it is applied on commit instead.
      composite: restoring ? 'source-over' : compositeFor(context),
    });
  };

  return {
    id: 'eraser',
    name: 'Eraser',
    shortcut: 'E',
    cursor: 'none',

    options: [
      {
        type: 'select',
        id: 'mode',
        label: 'Mode',
        default: 'brush',
        choices: [
          { value: 'brush', label: 'Brush' },
          { value: 'block', label: 'Block' },
        ],
      },
      ...strokeOptions(),
      {
        type: 'checkbox',
        id: 'eraseToBackground',
        label: 'Erase to background colour',
        default: false,
      },
    ],

    activate(context: ToolContext): void {
      checkpointLayerId = null;
      refreshCheckpoint(context);
    },

    onPointerDown(context: ToolContext, pointer: ToolPointer): void {
      const layer: Layer | null = paintableLayer(context);
      if (!layer) return;

      refreshCheckpoint(context);
      // Alt turns the eraser into a history brush for the duration of a stroke.
      restoring = pointer.altKey && checkpoint !== null && checkpointLayerId === layer.id;

      session = beginStrokeSession(layer, settingsFor(context));
      session.engine.begin(toBufferSample(pointer, layer));
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

      active.engine.update(settingsFor(context));
      for (const sample of pointer.coalesced) {
        active.engine.extend(toBufferSample(sample, active.layer));
      }

      showLive(context, active);
      context.invalidateComposite();
    },

    onPointerUp(context: ToolContext): void {
      const active = session;
      if (!active) return;
      session = null;

      active.engine.finish();
      const opacity = Math.min(Math.max(context.options.get<number>('opacity') / 100, 0), 1);
      const composite = compositeFor(context);
      const source = checkpoint;
      const restore = restoring && source !== null;
      restoring = false;

      commitStroke(context, active, restore ? 'Erase to History' : 'Erase', (layerCtx, buffer) => {
        if (restore && source) {
          // Cut the stroke shape away, then put the checkpoint pixels back
          // through the same shape, so transparent areas restore too.
          const patch = document.createElement('canvas');
          patch.width = buffer.width;
          patch.height = buffer.height;
          const patchCtx = patch.getContext('2d');
          if (!patchCtx) return;

          patchCtx.drawImage(source.bitmap, 0, 0);
          patchCtx.globalCompositeOperation = 'destination-in';
          patchCtx.drawImage(buffer, 0, 0);

          layerCtx.save();
          layerCtx.globalAlpha = opacity;
          layerCtx.globalCompositeOperation = 'destination-out';
          layerCtx.drawImage(buffer, 0, 0);
          layerCtx.globalCompositeOperation = 'source-over';
          layerCtx.drawImage(patch, 0, 0);
          layerCtx.restore();
          return;
        }

        layerCtx.save();
        layerCtx.globalAlpha = opacity;
        layerCtx.globalCompositeOperation = composite;
        layerCtx.drawImage(buffer, 0, 0);
        layerCtx.restore();
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
      if (modeOf(context) === 'block') {
        drawCursorOutline(ctx, centre, BLOCK_SCREEN_PX / 2, 'square');
        return;
      }
      const radius = (context.options.get<number>('size') / 2) * context.viewport.zoom;
      drawCursorOutline(ctx, centre, radius, 'round');
    },

    deactivate(context: ToolContext): void {
      hover = null;
      session = null;
      restoring = false;
      checkpointLayerId = null;
      checkpoint = null;
      context.setLiveStroke(null);
    },
  };
}
