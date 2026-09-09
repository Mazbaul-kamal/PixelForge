import { nearestZoomStop, nextZoomStop } from '../core/zoom-ladder';
import type { Point } from '../core/types';
import type { Tool, ToolContext, ToolPointer } from './types';

/** Below this much movement a press counts as a click, not a drag. */
const CLICK_SLOP_PX = 5;
/** Horizontal pixels per e-fold of zoom while dragging. */
const DRAG_SENSITIVITY = 0.006;

/**
 * Click to zoom in about the pointer, Alt+click to zoom out, or drag right and
 * left to zoom continuously about the point the drag started from.
 */
export function createZoomTool(): Tool {
  let dragging = false;
  let start: Point = { x: 0, y: 0 };
  let startZoom = 1;
  let travelled = 0;

  const applyZoom = (context: ToolContext, zoom: number, anchor: Point): void => {
    context.viewport.setZoom(zoom, anchor.x, anchor.y);
  };

  return {
    id: 'zoom',
    name: 'Zoom',
    shortcut: 'Z',
    cursor: 'zoom-in',

    options: [
      {
        type: 'button',
        id: 'fit',
        label: 'Fit',
        run: (context) => context.viewport.fitToScreen(context.doc.width, context.doc.height),
      },
      {
        type: 'button',
        id: 'actual',
        label: '100%',
        run: (context) => context.viewport.actualSize(context.doc.width, context.doc.height),
      },
      {
        type: 'button',
        id: 'fill',
        label: 'Fill',
        run: (context) => context.viewport.fillScreen(context.doc.width, context.doc.height),
      },
      {
        type: 'checkbox',
        id: 'smooth',
        label: 'Smooth zoom',
        default: false,
      },
    ],

    onPointerDown(context: ToolContext, pointer: ToolPointer): void {
      dragging = true;
      travelled = 0;
      start = pointer.screen;
      startZoom = context.viewport.zoom;
    },

    onPointerMove(context: ToolContext, pointer: ToolPointer): void {
      if (!dragging) {
        // Hovering: show which way a click would go.
        context.setCursor(pointer.altKey ? 'zoom-out' : 'zoom-in');
        return;
      }

      const dx = pointer.screen.x - start.x;
      travelled = Math.max(travelled, Math.hypot(dx, pointer.screen.y - start.y));
      if (travelled <= CLICK_SLOP_PX) return;

      const target = startZoom * Math.exp(dx * DRAG_SENSITIVITY);
      const smooth = context.options.get<boolean>('smooth');
      applyZoom(context, smooth ? target : nearestZoomStop(target), start);
    },

    onPointerUp(context: ToolContext, pointer: ToolPointer): void {
      if (dragging && travelled <= CLICK_SLOP_PX) {
        const direction: 1 | -1 = pointer.altKey ? -1 : 1;
        const smooth = context.options.get<boolean>('smooth');
        const zoom = smooth
          ? context.viewport.zoom * (direction > 0 ? 2 : 0.5)
          : nextZoomStop(context.viewport.zoom, direction);
        applyZoom(context, zoom, start);
      }
      dragging = false;
    },

    deactivate(context: ToolContext): void {
      dragging = false;
      context.setCursor(null);
    },
  };
}
