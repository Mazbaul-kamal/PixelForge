import type { Point } from '../core/types';
import type { Tool, ToolContext, ToolPointer } from './types';

/**
 * Pans the viewport. Deliberately the simplest possible tool: it exists to
 * prove the framework, and it is what Space temporarily switches to.
 */
export function createHandTool(): Tool {
  let dragging = false;
  let last: Point = { x: 0, y: 0 };

  return {
    id: 'hand',
    name: 'Hand',
    shortcut: 'H',
    cursor: 'grab',

    options: [
      {
        type: 'button',
        id: 'fit',
        label: 'Fit on Screen',
        run: (context) => {
          context.viewport.fitToScreen(context.doc.width, context.doc.height);
        },
      },
      {
        type: 'button',
        id: 'actual',
        label: '100%',
        run: (context) => {
          context.viewport.actualSize(context.doc.width, context.doc.height);
        },
      },
    ],

    onPointerDown(context: ToolContext, pointer: ToolPointer): void {
      dragging = true;
      last = pointer.screen;
      context.setCursor('grabbing');
    },

    onPointerMove(context: ToolContext, pointer: ToolPointer): void {
      if (!dragging) return;
      context.viewport.panBy(pointer.screen.x - last.x, pointer.screen.y - last.y);
      last = pointer.screen;
    },

    onPointerUp(context: ToolContext): void {
      dragging = false;
      context.setCursor(null);
    },

    deactivate(context: ToolContext): void {
      dragging = false;
      context.setCursor(null);
    },
  };
}
