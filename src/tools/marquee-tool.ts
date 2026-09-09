import { SelectionMask } from '../core/selection';
import type { CombineMode } from '../core/selection';
import { setSelection } from '../core/selection-ops';
import type { Point, Rect } from '../core/types';
import type { Tool, ToolContext, ToolPointer } from './types';

type SizeMode = 'normal' | 'ratio' | 'fixed';

/** Below this a drag is a click, which deselects. */
const CLICK_SLOP_PX = 2;

function normaliseRect(a: Point, b: Point): Rect {
  return {
    x: Math.round(Math.min(a.x, b.x)),
    y: Math.round(Math.min(a.y, b.y)),
    width: Math.round(Math.abs(b.x - a.x)),
    height: Math.round(Math.abs(b.y - a.y)),
  };
}

/**
 * Rectangular marquee. It only ever produces a SelectionMask, so every later
 * shape tool plugs into the same engine.
 */
export function createMarqueeTool(): Tool {
  let dragging = false;
  let anchor: Point = { x: 0, y: 0 };
  let current: Point = { x: 0, y: 0 };
  let travelled = 0;

  /** Combine mode fixed at pointer-down, before Shift means "square". */
  let strokeMode: CombineMode = 'new';
  let baseSelection: SelectionMask | null = null;

  /** Set when the drag started inside the selection and is moving it. */
  let movingSelection = false;
  let moveStart: Point = { x: 0, y: 0 };
  let movedFrom: SelectionMask | null = null;

  /** Live rectangle, drawn in the overlay until the drag commits. */
  let preview: Rect | null = null;

  const rectFor = (context: ToolContext, pointer: ToolPointer): Rect => {
    const mode = context.options.get<string>('sizeMode') as SizeMode;
    const fixedWidth = Math.max(1, context.options.get<number>('fixedWidth'));
    const fixedHeight = Math.max(1, context.options.get<number>('fixedHeight'));

    if (mode === 'fixed') {
      return {
        x: Math.round(anchor.x),
        y: Math.round(anchor.y),
        width: fixedWidth,
        height: fixedHeight,
      };
    }

    let end = current;

    if (mode === 'ratio') {
      const ratio = fixedWidth / fixedHeight;
      const width = end.x - anchor.x;
      const height = Math.sign(end.y - anchor.y || 1) * (Math.abs(width) / ratio);
      end = { x: end.x, y: anchor.y + height };
    } else if (pointer.shiftKey) {
      // Shift after the drag has begun constrains to a square.
      const side = Math.max(Math.abs(end.x - anchor.x), Math.abs(end.y - anchor.y));
      end = {
        x: anchor.x + Math.sign(end.x - anchor.x || 1) * side,
        y: anchor.y + Math.sign(end.y - anchor.y || 1) * side,
      };
    }

    // Alt during the drag grows the rectangle from its centre.
    if (pointer.altKey) {
      const dx = end.x - anchor.x;
      const dy = end.y - anchor.y;
      return normaliseRect({ x: anchor.x - dx, y: anchor.y - dy }, end);
    }
    return normaliseRect(anchor, end);
  };

  const maskFor = (context: ToolContext, rect: Rect): SelectionMask =>
    SelectionMask.fromShape(
      context.doc.width,
      context.doc.height,
      (ctx) => ctx.fillRect(rect.x, rect.y, rect.width, rect.height),
      {
        feather: context.options.get<number>('feather'),
        antiAlias: context.options.get<boolean>('antiAlias'),
      },
    );

  return {
    id: 'marquee',
    name: 'Rectangular Marquee',
    shortcut: 'M',
    cursor: 'crosshair',

    options: [
      {
        type: 'select',
        id: 'combine',
        label: 'Mode',
        default: 'new',
        choices: [
          { value: 'new', label: 'New' },
          { value: 'add', label: 'Add' },
          { value: 'subtract', label: 'Subtract' },
          { value: 'intersect', label: 'Intersect' },
        ],
      },
      { type: 'number', id: 'feather', label: 'Feather', min: 0, max: 250, default: 0, unit: 'px' },
      { type: 'checkbox', id: 'antiAlias', label: 'Anti-alias', default: true },
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
    ],

    onPointerDown(context: ToolContext, pointer: ToolPointer): void {
      dragging = true;
      travelled = 0;
      anchor = pointer.doc;
      current = pointer.doc;
      baseSelection = context.selection;

      // Modifiers at pointer-down choose the combine mode; the same keys mean
      // square and from-centre once the drag is under way.
      if (pointer.shiftKey && pointer.altKey) strokeMode = 'intersect';
      else if (pointer.shiftKey) strokeMode = 'add';
      else if (pointer.altKey) strokeMode = 'subtract';
      else strokeMode = context.options.get<string>('combine') as CombineMode;

      const inside =
        baseSelection !== null &&
        baseSelection.valueAt(Math.floor(pointer.doc.x), Math.floor(pointer.doc.y)) >= 128;

      // Dragging inside an existing selection moves the outline, not pixels.
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
        const moved = movedFrom.translated(
          pointer.doc.x - moveStart.x,
          pointer.doc.y - moveStart.y,
        );
        context.doc.selection = moved;
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
        // Put it back so the transaction records the move as one step.
        context.doc.selection = movedFrom;
        setSelection(context.doc, context.history, moved, 'Move Selection');
        movedFrom = null;
        context.requestRender();
        return;
      }

      const rect = preview ?? rectFor(context, pointer);
      preview = null;

      if (travelled <= CLICK_SLOP_PX || rect.width < 1 || rect.height < 1) {
        // A click with no drag clears the selection, as everywhere else.
        if (strokeMode === 'new' && baseSelection) {
          setSelection(context.doc, context.history, null, 'Deselect');
        }
        context.requestRender();
        return;
      }

      const shape = maskFor(context, rect);
      const combined =
        baseSelection && strokeMode !== 'new'
          ? baseSelection.combine(shape, strokeMode)
          : shape;

      setSelection(context.doc, context.history, combined, 'Rectangular Selection');
      context.requestRender();
    },

    drawOverlay(ctx: CanvasRenderingContext2D, context: ToolContext): void {
      if (!preview) return;

      const topLeft = context.viewport.docToScreen(preview.x, preview.y);
      const bottomRight = context.viewport.docToScreen(
        preview.x + preview.width,
        preview.y + preview.height,
      );
      const x = Math.round(topLeft.x) + 0.5;
      const y = Math.round(topLeft.y) + 0.5;
      const width = Math.round(bottomRight.x) - Math.round(topLeft.x);
      const height = Math.round(bottomRight.y) - Math.round(topLeft.y);

      ctx.save();
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = '#000000';
      ctx.strokeRect(x, y, width, height);
      ctx.lineDashOffset = 4;
      ctx.strokeStyle = '#ffffff';
      ctx.strokeRect(x, y, width, height);
      ctx.restore();
    },

    deactivate(): void {
      dragging = false;
      movingSelection = false;
      movedFrom = null;
      preview = null;
    },
  };
}
