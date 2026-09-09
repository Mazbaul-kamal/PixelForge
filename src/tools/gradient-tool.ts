import { fillThroughMasks } from '../core/fill-ops';
import { cloneGradient, gradientPresets, renderGradient } from '../core/gradient';
import type { GradientDefinition, GradientType, RenderOptions } from '../core/gradient';
import { BLEND_MODES, blendModeToComposite } from '../core/types';
import type { BlendMode, Point } from '../core/types';
import { constrainToAngles } from './selection-shape-tool';
import { paintableLayer } from './stroke-tool';
import type { Tool, ToolContext, ToolPointer } from './types';

/** Live preview renders no larger than this, then scales up. */
const PREVIEW_MAX_EDGE = 640;

export interface GradientDeps {
  /** The gradient being edited, shared with the editor dialog. */
  current: () => GradientDefinition;
  openEditor: () => void;
  onFilled: () => void;
}

function blendChoices() {
  return BLEND_MODES.map((mode) => ({
    value: mode,
    label: mode.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
  }));
}

export function createGradientTool(deps: GradientDeps): Tool {
  let dragging = false;
  let start: Point = { x: 0, y: 0 };
  let end: Point = { x: 0, y: 0 };
  let buffer: HTMLCanvasElement | null = null;

  const optionsFor = (context: ToolContext): RenderOptions => ({
    type: context.options.get<string>('type') as GradientType,
    reverse: context.options.get<boolean>('reverse'),
    dither: context.options.get<boolean>('dither'),
    transparency: context.options.get<boolean>('transparency'),
    foreground: context.colours.foreground,
    background: context.colours.background,
  });

  /** Paints the gradient into a patch, optionally at reduced resolution. */
  const paintGradient = (
    context: ToolContext,
    offsetX: number,
    offsetY: number,
    preview: boolean,
  ) =>
    (ctx: CanvasRenderingContext2D, width: number, height: number): void => {
      const scale = preview
        ? Math.min(1, PREVIEW_MAX_EDGE / Math.max(width, height))
        : 1;
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));

      const image = new ImageData(w, h);
      renderGradient(
        image,
        deps.current(),
        {
          startX: (start.x - offsetX) * scale,
          startY: (start.y - offsetY) * scale,
          endX: (end.x - offsetX) * scale,
          endY: (end.y - offsetY) * scale,
        },
        optionsFor(context),
      );

      if (scale === 1) {
        ctx.putImageData(image, 0, 0);
        return;
      }

      const small = document.createElement('canvas');
      small.width = w;
      small.height = h;
      small.getContext('2d')?.putImageData(image, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(small, 0, 0, width, height);
    };

  return {
    id: 'gradient',
    name: 'Gradient',
    shortcut: 'G',
    cursor: 'crosshair',

    options: [
      {
        type: 'select', id: 'preset', label: 'Preset', default: 'fg-bg',
        choices: gradientPresets().map((p) => ({ value: p.id, label: p.name })),
      },
      { type: 'button', id: 'edit', label: 'Edit…', title: 'Edit gradient', run: () => deps.openEditor() },
      {
        type: 'select', id: 'type', label: 'Type', default: 'linear',
        choices: [
          { value: 'linear', label: 'Linear' },
          { value: 'radial', label: 'Radial' },
          { value: 'angle', label: 'Angle' },
          { value: 'reflected', label: 'Reflected' },
          { value: 'diamond', label: 'Diamond' },
        ],
      },
      { type: 'select', id: 'blendMode', label: 'Mode', default: 'normal', choices: blendChoices() },
      { type: 'slider', id: 'opacity', label: 'Opacity', min: 0, max: 100, default: 100, unit: '%' },
      { type: 'checkbox', id: 'reverse', label: 'Reverse', default: false },
      { type: 'checkbox', id: 'dither', label: 'Dither', default: true },
      { type: 'checkbox', id: 'transparency', label: 'Transparency', default: true },
    ],

    onPointerDown(context: ToolContext, pointer: ToolPointer): void {
      const layer = paintableLayer(context);
      if (!layer) return;

      dragging = true;
      start = pointer.doc;
      end = pointer.doc;

      buffer = document.createElement('canvas');
      buffer.width = layer.canvas.width;
      buffer.height = layer.canvas.height;
      context.requestRender();
    },

    onPointerMove(context: ToolContext, pointer: ToolPointer): void {
      if (!dragging || !buffer) return;

      end = pointer.shiftKey
        ? constrainToAngles(start.x, start.y, pointer.doc.x, pointer.doc.y)
        : pointer.doc;

      const layer = context.activeLayer;
      const ctx = buffer.getContext('2d');
      if (!layer || !ctx) return;

      // A real preview of the result, not just the axis line.
      ctx.clearRect(0, 0, buffer.width, buffer.height);
      paintGradient(context, layer.x, layer.y, true)(ctx, buffer.width, buffer.height);
      context.selection?.applyClip(ctx, layer.x, layer.y);

      context.setLiveStroke({
        layerId: layer.id,
        canvas: buffer,
        opacity: context.options.get<number>('opacity') / 100,
        composite: blendModeToComposite(context.options.get<string>('blendMode') as BlendMode),
      });
      context.invalidateComposite();
    },

    onPointerUp(context: ToolContext): void {
      if (!dragging) return;
      dragging = false;
      buffer = null;
      context.setLiveStroke(null);

      const layer = paintableLayer(context);
      if (!layer) {
        context.invalidateComposite();
        return;
      }
      if (start.x === end.x && start.y === end.y) {
        context.invalidateComposite();
        return;
      }

      fillThroughMasks(
        context.doc, context.history, layer,
        paintGradient(context, layer.x, layer.y, false),
        [context.selection],
        {
          opacity: context.options.get<number>('opacity') / 100,
          blendMode: context.options.get<string>('blendMode') as BlendMode,
        },
        'Gradient',
      );
      deps.onFilled();
      context.invalidateComposite();
    },

    drawOverlay(ctx: CanvasRenderingContext2D, context: ToolContext): void {
      if (!dragging) return;
      const a = context.viewport.docToScreen(start.x, start.y);
      const b = context.viewport.docToScreen(end.x, end.y);

      ctx.save();
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.restore();
    },

    deactivate(context: ToolContext): void {
      dragging = false;
      buffer = null;
      context.setLiveStroke(null);
    },
  };
}

export { cloneGradient };
