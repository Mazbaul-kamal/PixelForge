import { SelectionMask } from '../core/selection';
import type { CombineMode } from '../core/selection';
import { setSelection } from '../core/selection-ops';
import {
  contractSelection, expandSelection, featherSelection, smoothSelection,
} from '../core/selection-refine';
import type { OptionSpec, ToolContext, ToolPointer } from './types';

/**
 * Everything the selection tools share. Only shape generation differs between
 * the rectangle, ellipse, lasso and polygon, so combine modes, feathering,
 * anti-aliasing and the refine controls all live here.
 */

function refineButton(
  id: string,
  label: string,
  title: string,
  apply: (mask: SelectionMask, amount: number) => SelectionMask,
): OptionSpec {
  return {
    type: 'button',
    id,
    label,
    title,
    run: (context: ToolContext): void => {
      const current = context.doc.selection;
      if (!current) return;
      const amount = Math.max(0, context.options.get<number>('refineAmount'));
      setSelection(context.doc, context.history, apply(current, amount), title);
    },
  };
}

export function selectionOptions(extra: readonly OptionSpec[] = []): OptionSpec[] {
  return [
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
    ...extra,
    // Refine applies to whatever is currently selected, from any tool.
    { type: 'number', id: 'refineAmount', label: 'Refine', min: 1, max: 250, default: 4, unit: 'px' },
    refineButton('expand', 'Expand', 'Expand selection', expandSelection),
    refineButton('contract', 'Contract', 'Contract selection', contractSelection),
    refineButton('featherMore', 'Feather', 'Feather selection', featherSelection),
    refineButton('smooth', 'Smooth', 'Smooth selection', smoothSelection),
  ];
}

/**
 * Modifiers held at pointer-down choose how the new shape combines. The same
 * keys mean something else once the drag is running, so this is read once.
 */
export function combineModeFor(context: ToolContext, pointer: ToolPointer): CombineMode {
  if (pointer.shiftKey && pointer.altKey) return 'intersect';
  if (pointer.shiftKey) return 'add';
  if (pointer.altKey) return 'subtract';
  return context.options.get<string>('combine') as CombineMode;
}

/** Rasterises a path into a mask, honouring the feather and anti-alias options. */
export function buildShapeMask(
  context: ToolContext,
  draw: (ctx: CanvasRenderingContext2D) => void,
): SelectionMask {
  return SelectionMask.fromShape(context.doc.width, context.doc.height, draw, {
    feather: context.options.get<number>('feather'),
    antiAlias: context.options.get<boolean>('antiAlias'),
  });
}

export function commitShapeSelection(
  context: ToolContext,
  base: SelectionMask | null,
  shape: SelectionMask,
  mode: CombineMode,
  label: string,
): void {
  const combined = base && mode !== 'new' ? base.combine(shape, mode) : shape;
  setSelection(context.doc, context.history, combined, label);
}

/** Snaps a segment to 45 degree increments, for Shift-constrained drawing. */
export function constrainToAngles(fromX: number, fromY: number, toX: number, toY: number) {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const length = Math.hypot(dx, dy);
  if (length === 0) return { x: toX, y: toY };

  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: fromX + Math.cos(angle) * length, y: fromY + Math.sin(angle) * length };
}

/** Dashed outline used by every in-progress selection shape. */
export function strokePreview(
  ctx: CanvasRenderingContext2D,
  build: (target: CanvasRenderingContext2D) => void,
): void {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = '#000000';
  build(ctx);
  ctx.stroke();
  ctx.setLineDash([4, 4]);
  ctx.lineDashOffset = 4;
  ctx.strokeStyle = '#ffffff';
  build(ctx);
  ctx.stroke();
  ctx.restore();
}
