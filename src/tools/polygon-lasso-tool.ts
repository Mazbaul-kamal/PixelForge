import type { SelectionMask } from '../core/selection';
import type { CombineMode } from '../core/selection';
import type { Point } from '../core/types';
import {
  buildShapeMask, combineModeFor, commitShapeSelection, constrainToAngles, selectionOptions,
  strokePreview,
} from './selection-shape-tool';
import type { Tool, ToolContext, ToolPointer } from './types';

/** Screen pixels within which a click counts as landing on the first vertex. */
const CLOSE_RADIUS_PX = 8;
const DOUBLE_CLICK_MS = 350;

/**
 * Polygonal lasso: click to place vertices, with a rubber band to the cursor.
 * Backspace removes the last vertex, Escape cancels, and either a double-click
 * or a click on the first vertex closes the shape.
 */
export function createPolygonLassoTool(): Tool {
  let vertices: Point[] = [];
  let cursor: Point | null = null;
  let strokeMode: CombineMode = 'new';
  let baseSelection: SelectionMask | null = null;
  let lastClickAt = 0;
  let lastClickAt_screen: Point = { x: 0, y: 0 };

  const reset = (): void => {
    vertices = [];
    cursor = null;
  };

  const commit = (context: ToolContext): void => {
    const path = vertices;
    reset();
    if (path.length < 3) {
      context.requestRender();
      return;
    }

    const mask = buildShapeMask(context, (ctx) => {
      ctx.beginPath();
      ctx.moveTo(path[0]!.x, path[0]!.y);
      for (let i = 1; i < path.length; i++) ctx.lineTo(path[i]!.x, path[i]!.y);
      ctx.closePath();
      ctx.fill('nonzero');
    });
    commitShapeSelection(context, baseSelection, mask, strokeMode, 'Polygonal Selection');
    context.requestRender();
  };

  return {
    id: 'polygon-lasso',
    name: 'Polygonal Lasso',
    shortcut: 'L',
    cursor: 'crosshair',
    options: selectionOptions(),

    onPointerDown(context: ToolContext, pointer: ToolPointer): void {
      const now = performance.now();
      // Both tests matter: time alone would let fast clicking at different
      // points close the shape by accident.
      const isDoubleClick =
        now - lastClickAt < DOUBLE_CLICK_MS &&
        Math.hypot(
          pointer.screen.x - lastClickAt_screen.x,
          pointer.screen.y - lastClickAt_screen.y,
        ) <= CLOSE_RADIUS_PX;
      lastClickAt = now;
      lastClickAt_screen = pointer.screen;

      if (vertices.length === 0) {
        baseSelection = context.selection;
        strokeMode = combineModeFor(context, pointer);
        vertices = [pointer.doc];
        cursor = pointer.doc;
        context.requestRender();
        return;
      }

      const first = vertices[0]!;
      const firstOnScreen = context.viewport.docToScreen(first.x, first.y);
      const onFirst =
        Math.hypot(pointer.screen.x - firstOnScreen.x, pointer.screen.y - firstOnScreen.y) <=
        CLOSE_RADIUS_PX;

      if (onFirst || isDoubleClick) {
        commit(context);
        return;
      }

      vertices.push(nextVertex(context, pointer));
      context.requestRender();
    },

    onPointerMove(context: ToolContext, pointer: ToolPointer): void {
      if (vertices.length === 0) return;
      cursor = nextVertex(context, pointer);
      context.requestRender();
    },

    onPointerUp(): void {
      // Vertices are placed on pointer-down; nothing to do when it lifts.
    },

    onKeyDown(context: ToolContext, event: KeyboardEvent): boolean {
      if (vertices.length === 0) return false;

      if (event.key === 'Backspace') {
        vertices.pop();
        // The click that placed the removed vertex must not pair with the next
        // one, or re-clicking the same spot would read as a double click.
        lastClickAt = 0;
        context.requestRender();
        return true;
      }
      if (event.key === 'Escape') {
        reset();
        lastClickAt = 0;
        context.requestRender();
        return true;
      }
      if (event.key === 'Enter') {
        commit(context);
        return true;
      }
      return false;
    },

    drawOverlay(ctx: CanvasRenderingContext2D, context: ToolContext): void {
      if (vertices.length === 0) return;

      const screen = vertices.map((p) => context.viewport.docToScreen(p.x, p.y));
      const rubberBand = cursor ? context.viewport.docToScreen(cursor.x, cursor.y) : null;

      strokePreview(ctx, (target) => {
        target.beginPath();
        target.moveTo(screen[0]!.x, screen[0]!.y);
        for (let i = 1; i < screen.length; i++) target.lineTo(screen[i]!.x, screen[i]!.y);
        if (rubberBand) target.lineTo(rubberBand.x, rubberBand.y);
        target.closePath();
      });

      // A handle on the first vertex, so it is obvious where the path closes.
      const first = screen[0]!;
      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.rect(first.x - 3, first.y - 3, 6, 6);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    },

    deactivate(): void {
      reset();
    },
  };

  /** Shift constrains the new segment to 45 degree increments. */
  function nextVertex(context: ToolContext, pointer: ToolPointer): Point {
    void context;
    const last = vertices[vertices.length - 1];
    if (!last || !pointer.shiftKey) return pointer.doc;
    return constrainToAngles(last.x, last.y, pointer.doc.x, pointer.doc.y);
  }
}
