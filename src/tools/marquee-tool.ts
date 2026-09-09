import type { SelectionMask } from '../core/selection';
import type { CombineMode } from '../core/selection';
import { setSelection } from '../core/selection-ops';
import type { Point, Rect } from '../core/types';
import {
  buildShapeMask, combineModeFor, commitShapeSelection, selectionOptions, strokePreview,
} from './selection-shape-tool';
import type { OptionSpec, Tool, ToolContext, ToolPointer } from './types';

type SizeMode = 'normal' | 'ratio' | 'fixed';
type MarqueeShape = 'rectangle' | 'ellipse';

const CLICK_SLOP_PX = 2;

const SIZE_OPTIONS: readonly OptionSpec[] = [
  {
    type: 'select',
    id: 'sizeMode',
    label: 'Style',
    default: 'normal',
    choices: [
      { value: 'normal', label: 'Normal' },
      { value: 'ratio', label: 'Fixed ratio' },
      { value: 'fixed', label: 'Fixed size' },
    ],
  },
  { type: 'number', id: 'fixedWidth', label: 'W', min: 1, max: 20000, default: 100 },
  { type: 'number', id: 'fixedHeight', label: 'H', min: 1, max: 20000, default: 100 },
];

function normaliseRect(a: Point, b: Point): Rect {
  return {
    x: Math.round(Math.min(a.x, b.x)),
    y: Math.round(Math.min(a.y, b.y)),
    width: Math.round(Math.abs(b.x - a.x)),
    height: Math.round(Math.abs(b.y - a.y)),
  };
}

/**
 * The rectangular and elliptical marquees differ only in the path they trace,
 * so both come out of this one factory. The ellipse is rasterised by filling a
 * path onto the mask's scratch canvas, never by a hand-written rasteriser.
 */
export function createMarqueeTool(shape: MarqueeShape): Tool {
  let dragging = false;
  let anchor: Point = { x: 0, y: 0 };
  let current: Point = { x: 0, y: 0 };
  let travelled = 0;
  let strokeMode: CombineMode = 'new';
  let baseSelection: SelectionMask | null = null;
  let movingSelection = false;
  let moveStart: Point = { x: 0, y: 0 };
  let movedFrom: SelectionMask | null = null;
  let preview: Rect | null = null;

  const tracePath = (ctx: CanvasRenderingContext2D, rect: Rect): void => {
    ctx.beginPath();
    if (shape === 'ellipse') {
      ctx.ellipse(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
        rect.width / 2,
        rect.height / 2,
        0,
        0,
        Math.PI * 2,
      );
    } else {
      ctx.rect(rect.x, rect.y, rect.width, rect.height);
    }
  };

  const rectFor = (context: ToolContext, pointer: ToolPointer): Rect => {
    const mode = context.options.get<string>('sizeMode') as SizeMode;
    const fixedWidth = Math.max(1, context.options.get<number>('fixedWidth'));
    const fixedHeight = Math.max(1, context.options.get<number>('fixedHeight'));

    if (mode === 'fixed') {
      return { x: Math.round(anchor.x), y: Math.round(anchor.y), width: fixedWidth, height: fixedHeight };
    }

    let end = current;
    if (mode === 'ratio') {
      const ratio = fixedWidth / fixedHeight;
      const width = end.x - anchor.x;
      end = { x: end.x, y: anchor.y + Math.sign(end.y - anchor.y || 1) * (Math.abs(width) / ratio) };
    } else if (pointer.shiftKey) {
      // Shift once the drag has begun means a square or a circle.
      const side = Math.max(Math.abs(end.x - anchor.x), Math.abs(end.y - anchor.y));
      end = {
        x: anchor.x + Math.sign(end.x - anchor.x || 1) * side,
        y: anchor.y + Math.sign(end.y - anchor.y || 1) * side,
      };
    }

    if (pointer.altKey) {
      const dx = end.x - anchor.x;
      const dy = end.y - anchor.y;
      return normaliseRect({ x: anchor.x - dx, y: anchor.y - dy }, end);
    }
    return normaliseRect(anchor, end);
  };

  return {
    id: shape === 'ellipse' ? 'ellipse-marquee' : 'marquee',
    name: shape === 'ellipse' ? 'Elliptical Marquee' : 'Rectangular Marquee',
    shortcut: 'M',
    cursor: 'crosshair',
    options: selectionOptions(SIZE_OPTIONS),

    onPointerDown(context: ToolContext, pointer: ToolPointer): void {
      dragging = true;
      travelled = 0;
      anchor = pointer.doc;
      current = pointer.doc;
      baseSelection = context.selection;
      strokeMode = combineModeFor(context, pointer);

      const inside =
        baseSelection !== null &&
        baseSelection.valueAt(Math.floor(pointer.doc.x), Math.floor(pointer.doc.y)) >= 128;

      movingSelection = inside && strokeMode === 'new';
      if (movingSelection) {
        moveStart = pointer.doc;
        movedFrom = baseSelection;
        preview = null;
        return;
      }

      preview = normaliseRect(anchor, current);
      context.requestRender();
    },

    onPointerMove(context: ToolContext, pointer: ToolPointer): void {
      if (!dragging) return;
      current = pointer.doc;
      travelled = Math.max(travelled, Math.hypot(current.x - anchor.x, current.y - anchor.y));

      if (movingSelection && movedFrom) {
        context.doc.selection = movedFrom.translated(
          pointer.doc.x - moveStart.x,
          pointer.doc.y - moveStart.y,
        );
        context.requestRender();
        return;
      }

      preview = rectFor(context, pointer);
      context.requestRender();
    },

    onPointerUp(context: ToolContext, pointer: ToolPointer): void {
      if (!dragging) return;
      dragging = false;

      if (movingSelection && movedFrom) {
        movingSelection = false;
        const moved = context.doc.selection;
        context.doc.selection = movedFrom;
        setSelection(context.doc, context.history, moved, 'Move Selection');
        movedFrom = null;
        context.requestRender();
        return;
      }

      const rect = preview ?? rectFor(context, pointer);
      preview = null;

      if (travelled <= CLICK_SLOP_PX || rect.width < 1 || rect.height < 1) {
        if (strokeMode === 'new' && baseSelection) {
          setSelection(context.doc, context.history, null, 'Deselect');
        }
        context.requestRender();
        return;
      }

      const mask = buildShapeMask(context, (ctx) => {
        tracePath(ctx, rect);
        ctx.fill();
      });
      commitShapeSelection(context, baseSelection, mask, strokeMode,
        shape === 'ellipse' ? 'Elliptical Selection' : 'Rectangular Selection');
      context.requestRender();
    },

    drawOverlay(ctx: CanvasRenderingContext2D, context: ToolContext): void {
      if (!preview) return;
      const topLeft = context.viewport.docToScreen(preview.x, preview.y);
      const bottomRight = context.viewport.docToScreen(
        preview.x + preview.width,
        preview.y + preview.height,
      );
      const screenRect: Rect = {
        x: Math.round(topLeft.x) + 0.5,
        y: Math.round(topLeft.y) + 0.5,
        width: Math.round(bottomRight.x) - Math.round(topLeft.x),
        height: Math.round(bottomRight.y) - Math.round(topLeft.y),
      };
      strokePreview(ctx, (target) => tracePath(target, screenRect));
    },

    deactivate(): void {
      dragging = false;
      movingSelection = false;
      movedFrom = null;
      preview = null;
    },
  };
}
