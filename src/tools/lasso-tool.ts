import type { SelectionMask } from '../core/selection';
import type { CombineMode } from '../core/selection';
import type { Point } from '../core/types';
import {
  buildShapeMask, combineModeFor, commitShapeSelection, selectionOptions, strokePreview,
} from './selection-shape-tool';
import type { Tool, ToolContext, ToolPointer } from './types';

/** Points closer together than this add nothing but work. */
const MIN_POINT_GAP = 1.2;

/** Freehand lasso. The path closes itself and fills by non-zero winding. */
export function createLassoTool(): Tool {
  let points: Point[] = [];
  let drawing = false;
  let strokeMode: CombineMode = 'new';
  let baseSelection: SelectionMask | null = null;

  const tracePath = (ctx: CanvasRenderingContext2D, path: readonly Point[]): void => {
    const first = path[0];
    if (!first) return;
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < path.length; i++) ctx.lineTo(path[i]!.x, path[i]!.y);
    ctx.closePath();
  };

  return {
    id: 'lasso',
    name: 'Lasso',
    shortcut: 'L',
    cursor: 'crosshair',
    options: selectionOptions(),

    onPointerDown(context: ToolContext, pointer: ToolPointer): void {
      drawing = true;
      points = [pointer.doc];
      baseSelection = context.selection;
      strokeMode = combineModeFor(context, pointer);
      context.requestRender();
    },

    onPointerMove(context: ToolContext, pointer: ToolPointer): void {
      if (!drawing) return;

      // Every coalesced sample matters: a fast lasso would otherwise be a
      // handful of long straight segments.
      for (const sample of pointer.coalesced) {
        const last = points[points.length - 1];
        if (last && Math.hypot(sample.doc.x - last.x, sample.doc.y - last.y) < MIN_POINT_GAP) {
          continue;
        }
        points.push(sample.doc);
      }
      context.requestRender();
    },

    onPointerUp(context: ToolContext): void {
      if (!drawing) return;
      drawing = false;

      const path = points;
      points = [];

      if (path.length < 3) {
        context.requestRender();
        return;
      }

      const mask = buildShapeMask(context, (ctx) => {
        tracePath(ctx, path);
        ctx.fill('nonzero');
      });
      commitShapeSelection(context, baseSelection, mask, strokeMode, 'Lasso Selection');
      context.requestRender();
    },

    drawOverlay(ctx: CanvasRenderingContext2D, context: ToolContext): void {
      if (points.length < 2) return;
      const screen = points.map((p) => context.viewport.docToScreen(p.x, p.y));
      strokePreview(ctx, (target) => {
        target.beginPath();
        target.moveTo(screen[0]!.x, screen[0]!.y);
        for (let i = 1; i < screen.length; i++) target.lineTo(screen[i]!.x, screen[i]!.y);
        target.closePath();
      });
    },

    deactivate(): void {
      drawing = false;
      points = [];
    },
  };
}
