import { applyCrop, straightenRect } from '../core/crop-ops';
import type { Point, Rect } from '../core/types';
import type { Tool, ToolContext, ToolPointer } from './types';

type HandleId =
  | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
  | 'move' | null;

const HANDLE_HIT_PX = 10;
const HANDLE_SIZE = 8;

const ASPECTS: Record<string, number | null> = {
  free: null,
  original: null,
  '1:1': 1,
  '4:3': 4 / 3,
  '3:2': 3 / 2,
  '16:9': 16 / 9,
  custom: null,
};

const CURSORS: Record<string, string> = {
  nw: 'nwse-resize', se: 'nwse-resize',
  ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize',
  e: 'ew-resize', w: 'ew-resize',
  move: 'move',
};

function normalise(rect: Rect): Rect {
  return {
    x: Math.round(Math.min(rect.x, rect.x + rect.width)),
    y: Math.round(Math.min(rect.y, rect.y + rect.height)),
    width: Math.max(1, Math.round(Math.abs(rect.width))),
    height: Math.max(1, Math.round(Math.abs(rect.height))),
  };
}

export interface CropDeps {
  onCommitted: () => void;
}

/**
 * Crop with 8 handles, aspect presets, grid overlays and straighten.
 *
 * The crop rectangle may extend past the document, which grows the canvas with
 * transparent pixels, and with "Delete cropped pixels" off the crop is purely
 * structural so the hidden pixels come back if you crop again.
 */
export function createCropTool(deps: CropDeps): Tool {
  let crop: Rect | null = null;
  let dragging: HandleId = null;
  let dragStart: Point = { x: 0, y: 0 };
  let startRect: Rect = { x: 0, y: 0, width: 0, height: 0 };
  let hoverHandle: HandleId = null;

  /** Straighten line, in document coordinates, while it is being drawn. */
  let straightenFrom: Point | null = null;
  let straightenTo: Point | null = null;

  const reset = (context: ToolContext): void => {
    crop = { x: 0, y: 0, width: context.doc.width, height: context.doc.height };
  };

  const aspectFor = (context: ToolContext): number | null => {
    const key = context.options.get<string>('aspect');
    if (key === 'original') return context.doc.width / context.doc.height;
    if (key === 'custom') {
      const w = context.options.get<number>('customWidth');
      const h = context.options.get<number>('customHeight');
      return w > 0 && h > 0 ? w / h : null;
    }
    return ASPECTS[key] ?? null;
  };

  const handleAt = (context: ToolContext, screen: Point): HandleId => {
    if (!crop) return null;
    const topLeft = context.viewport.docToScreen(crop.x, crop.y);
    const bottomRight = context.viewport.docToScreen(crop.x + crop.width, crop.y + crop.height);
    const midX = (topLeft.x + bottomRight.x) / 2;
    const midY = (topLeft.y + bottomRight.y) / 2;

    const spots: [HandleId, number, number][] = [
      ['nw', topLeft.x, topLeft.y], ['n', midX, topLeft.y], ['ne', bottomRight.x, topLeft.y],
      ['e', bottomRight.x, midY], ['se', bottomRight.x, bottomRight.y],
      ['s', midX, bottomRight.y], ['sw', topLeft.x, bottomRight.y], ['w', topLeft.x, midY],
    ];
    for (const [id, x, y] of spots) {
      if (Math.hypot(screen.x - x, screen.y - y) <= HANDLE_HIT_PX) return id;
    }

    const inside =
      screen.x >= topLeft.x && screen.x <= bottomRight.x &&
      screen.y >= topLeft.y && screen.y <= bottomRight.y;
    return inside ? 'move' : null;
  };

  const resize = (handle: HandleId, delta: Point, aspect: number | null, fromCentre: boolean): Rect => {
    let { x, y, width, height } = startRect;
    const right = x + width;
    const bottom = y + height;

    if (handle === 'move') return { x: x + delta.x, y: y + delta.y, width, height };

    const west = handle === 'nw' || handle === 'w' || handle === 'sw';
    const east = handle === 'ne' || handle === 'e' || handle === 'se';
    const north = handle === 'nw' || handle === 'n' || handle === 'ne';
    const south = handle === 'sw' || handle === 's' || handle === 'se';

    if (west) { x = x + delta.x; width = right - x; }
    if (east) width = width + delta.x;
    if (north) { y = y + delta.y; height = bottom - y; }
    if (south) height = height + delta.y;

    if (aspect) {
      // Drive the free axis from the constrained one.
      if (west || east) height = width / aspect;
      else width = height * aspect;
      if (north) y = bottom - height;
      if (west) x = right - width;
    }

    if (fromCentre) {
      const cx = startRect.x + startRect.width / 2;
      const cy = startRect.y + startRect.height / 2;
      const halfW = Math.abs(width) / 2;
      const halfH = Math.abs(height) / 2;
      return normalise({ x: cx - halfW, y: cy - halfH, width: halfW * 2, height: halfH * 2 });
    }

    return normalise({ x, y, width, height });
  };

  const commit = (context: ToolContext): void => {
    if (!crop) return;
    const target = crop;
    crop = null;

    applyCrop(context.doc, context.history, target, {
      deletePixels: context.options.get<boolean>('deletePixels'),
      resampleWidth: context.options.get<number>('resampleWidth'),
    });
    deps.onCommitted();
    reset(context);
    context.requestRender();
  };

  return {
    id: 'crop',
    name: 'Crop',
    shortcut: 'C',
    cursor: 'crosshair',

    options: [
      {
        type: 'select', id: 'aspect', label: 'Ratio', default: 'free',
        choices: [
          { value: 'free', label: 'Free' }, { value: 'original', label: 'Original' },
          { value: '1:1', label: '1:1' }, { value: '4:3', label: '4:3' },
          { value: '3:2', label: '3:2' }, { value: '16:9', label: '16:9' },
          { value: 'custom', label: 'Custom' },
        ],
      },
      { type: 'number', id: 'customWidth', label: 'W', min: 1, max: 20000, default: 4 },
      { type: 'number', id: 'customHeight', label: 'H', min: 1, max: 20000, default: 5 },
      { type: 'number', id: 'resampleWidth', label: 'Resample to', min: 0, max: 20000, default: 0, unit: 'px' },
      { type: 'checkbox', id: 'straighten', label: 'Straighten', default: false },
      { type: 'checkbox', id: 'deletePixels', label: 'Delete cropped pixels', default: false },
      {
        type: 'select', id: 'grid', label: 'Grid', default: 'thirds',
        choices: [
          { value: 'none', label: 'None' }, { value: 'thirds', label: 'Rule of thirds' },
          { value: 'golden', label: 'Golden ratio' }, { value: 'fine', label: 'Fine grid' },
        ],
      },
      {
        type: 'button', id: 'apply', label: '✓', title: 'Apply the crop (Enter)',
        run: (context) => commit(context),
      },
      {
        type: 'button', id: 'cancel', label: '✕', title: 'Cancel (Escape)',
        run: (context) => { reset(context); context.requestRender(); },
      },
    ],

    activate(context: ToolContext): void {
      reset(context);
      context.requestRender();
    },

    onPointerDown(context: ToolContext, pointer: ToolPointer): void {
      if (context.options.get<boolean>('straighten')) {
        straightenFrom = pointer.doc;
        straightenTo = pointer.doc;
        return;
      }
      if (!crop) reset(context);

      dragging = handleAt(context, pointer.screen);
      dragStart = pointer.doc;
      startRect = crop ? { ...crop } : { x: 0, y: 0, width: 0, height: 0 };
      context.requestRender();
    },

    onPointerMove(context: ToolContext, pointer: ToolPointer): void {
      if (straightenFrom) {
        straightenTo = pointer.doc;
        context.requestRender();
        return;
      }

      if (!dragging) {
        hoverHandle = handleAt(context, pointer.screen);
        context.setCursor(hoverHandle ? CURSORS[hoverHandle] ?? null : null);
        return;
      }

      const delta = { x: pointer.doc.x - dragStart.x, y: pointer.doc.y - dragStart.y };
      const aspect = pointer.shiftKey ? aspectFor(context) ?? startRect.width / startRect.height
        : aspectFor(context);
      crop = resize(dragging, delta, aspect, pointer.altKey && dragging !== 'move');
      context.requestRender();
    },

    onPointerUp(context: ToolContext): void {
      if (straightenFrom && straightenTo) {
        const dx = straightenTo.x - straightenFrom.x;
        const dy = straightenTo.y - straightenFrom.y;
        straightenFrom = null;
        straightenTo = null;

        if (Math.hypot(dx, dy) > 4) {
          // The drawn line should end up horizontal, so rotate by its negation
          // and crop to the biggest rectangle with no empty corner.
          const angle = -Math.atan2(dy, dx);
          const target = straightenRect(context.doc, angle);
          applyCrop(context.doc, context.history, target, {
            deletePixels: true,
            angle,
            resampleWidth: 0,
          });
          context.options.set('straighten', false);
          deps.onCommitted();
          reset(context);
        }
        context.requestRender();
        return;
      }

      dragging = null;
      context.requestRender();
    },

    onKeyDown(context: ToolContext, event: KeyboardEvent): boolean {
      if (event.key === 'Enter') {
        commit(context);
        return true;
      }
      if (event.key === 'Escape') {
        reset(context);
        context.requestRender();
        return true;
      }
      return false;
    },

    drawOverlay(ctx: CanvasRenderingContext2D, context: ToolContext): void {
      if (straightenFrom && straightenTo) {
        const a = context.viewport.docToScreen(straightenFrom.x, straightenFrom.y);
        const b = context.viewport.docToScreen(straightenTo.x, straightenTo.y);
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
        return;
      }

      if (!crop) return;
      const topLeft = context.viewport.docToScreen(crop.x, crop.y);
      const bottomRight = context.viewport.docToScreen(crop.x + crop.width, crop.y + crop.height);
      const x = topLeft.x;
      const y = topLeft.y;
      const width = bottomRight.x - topLeft.x;
      const height = bottomRight.y - topLeft.y;

      ctx.save();
      // Darken everything outside the crop.
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.beginPath();
      ctx.rect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.rect(x, y, width, height);
      ctx.fill('evenodd');

      const grid = context.options.get<string>('grid');
      if (grid !== 'none') {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
        ctx.lineWidth = 1;
        ctx.beginPath();

        const fractions =
          grid === 'thirds' ? [1 / 3, 2 / 3]
          : grid === 'golden' ? [0.382, 0.618]
          : [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875];

        for (const f of fractions) {
          ctx.moveTo(x + width * f, y);
          ctx.lineTo(x + width * f, y + height);
          ctx.moveTo(x, y + height * f);
          ctx.lineTo(x + width, y + height * f);
        }
        ctx.stroke();
      }

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(width), Math.round(height));

      const half = HANDLE_SIZE / 2;
      const midX = x + width / 2;
      const midY = y + height / 2;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
      for (const [hx, hy] of [
        [x, y], [midX, y], [x + width, y], [x + width, midY],
        [x + width, y + height], [midX, y + height], [x, y + height], [x, midY],
      ] as const) {
        ctx.fillRect(hx - half, hy - half, HANDLE_SIZE, HANDLE_SIZE);
        ctx.strokeRect(hx - half, hy - half, HANDLE_SIZE, HANDLE_SIZE);
      }
      ctx.restore();
    },

    deactivate(context: ToolContext): void {
      crop = null;
      dragging = null;
      straightenFrom = null;
      straightenTo = null;
      context.setCursor(null);
    },
  };
}
