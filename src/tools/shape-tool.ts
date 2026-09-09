import { createLayer } from '../core/layer';
import { canEditLayer } from '../core/layer-ops';
import {
  applyShapeToLayer, DEFAULT_STROKE, defaultParams, shapeBounds,
} from '../core/shape-layer';
import type {
  PathOp, ShapeData, ShapeKind, ShapeParams, StrokeAlign,
} from '../core/shape-layer';
import type { Layer, Point } from '../core/types';
import type { Tool, ToolContext, ToolPointer } from './types';

/** Handles are drawn in screen space, so they never change size with zoom. */
const HANDLE_SIZE = 8;
const HANDLE_HIT = 10;
const ROTATE_OFFSET = 26;

type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate' | 'radius' | null;

export interface ShapeDeps {
  onChanged: () => void;
}

function withParams(data: ShapeData, params: Partial<ShapeParams>): ShapeData {
  const [first, ...rest] = data.components;
  if (!first) return data;
  return {
    ...data,
    components: [{ ...first, params: { ...first.params, ...params } }, ...rest],
  };
}

export function createShapeTool(deps: ShapeDeps): Tool {
  let drawing = false;
  let anchor: Point = { x: 0, y: 0 };
  let draftLayer: Layer | null = null;

  let handle: HandleId = null;
  let handleStart: Point = { x: 0, y: 0 };
  let startParams: ShapeParams | null = null;

  const styleFrom = (context: ToolContext): Pick<ShapeData, 'fill' | 'stroke'> => ({
    fill: context.options.get<boolean>('hasFill') ? context.colours.foreground : null,
    stroke: {
      ...DEFAULT_STROKE,
      colour: context.options.get<string>('strokeColour'),
      width: context.options.get<number>('strokeWidth'),
      align: context.options.get<string>('strokeAlign') as StrokeAlign,
      dash: context.options.get<number>('dash') > 0
        ? [context.options.get<number>('dash'), context.options.get<number>('dash')]
        : [],
    },
  });

  const paramsFrom = (context: ToolContext, rect: {
    x: number; y: number; width: number; height: number;
  }): ShapeParams => {
    const radius = context.options.get<number>('cornerRadius');
    return {
      ...defaultParams(rect.x, rect.y, rect.width, rect.height),
      cornerRadii: [radius, radius, radius, radius],
      sides: context.options.get<number>('sides'),
      points: context.options.get<number>('points'),
      inset: context.options.get<number>('inset') / 100,
    };
  };

  /** The shape layer being edited, if the active layer is one. */
  const editable = (context: ToolContext): Layer | null => {
    const layer = context.activeLayer;
    return layer && layer.type === 'shape' && layer.shape && canEditLayer(layer) ? layer : null;
  };

  const handlePositions = (context: ToolContext, layer: Layer): [HandleId, number, number][] => {
    const data = layer.shape;
    if (!data) return [];
    const bounds = shapeBounds(data);

    const topLeft = context.viewport.docToScreen(bounds.x, bounds.y);
    const bottomRight = context.viewport.docToScreen(
      bounds.x + bounds.width, bounds.y + bounds.height,
    );
    const midX = (topLeft.x + bottomRight.x) / 2;
    const midY = (topLeft.y + bottomRight.y) / 2;

    const spots: [HandleId, number, number][] = [
      ['nw', topLeft.x, topLeft.y], ['n', midX, topLeft.y], ['ne', bottomRight.x, topLeft.y],
      ['e', bottomRight.x, midY], ['se', bottomRight.x, bottomRight.y],
      ['s', midX, bottomRight.y], ['sw', topLeft.x, bottomRight.y], ['w', topLeft.x, midY],
      ['rotate', midX, topLeft.y - ROTATE_OFFSET],
    ];
    if (data.components[0]?.kind === 'rectangle') {
      // The radius handle rides just inside the top-left corner.
      spots.push(['radius', topLeft.x + 14, topLeft.y + 14]);
    }
    return spots;
  };

  const hitHandle = (context: ToolContext, layer: Layer, screen: Point): HandleId => {
    for (const [id, x, y] of handlePositions(context, layer)) {
      if (Math.hypot(screen.x - x, screen.y - y) <= HANDLE_HIT) return id;
    }
    return null;
  };

  const resizeParams = (
    id: HandleId, start: ShapeParams, delta: Point, keepAspect: boolean,
  ): Partial<ShapeParams> => {
    let { x, y, width, height } = start;
    const right = x + width;
    const bottom = y + height;

    const west = id === 'nw' || id === 'w' || id === 'sw';
    const east = id === 'ne' || id === 'e' || id === 'se';
    const north = id === 'nw' || id === 'n' || id === 'ne';
    const south = id === 'sw' || id === 's' || id === 'se';

    if (west) { x += delta.x; width = right - x; }
    if (east) width += delta.x;
    if (north) { y += delta.y; height = bottom - y; }
    if (south) height += delta.y;

    if (keepAspect && start.height !== 0) {
      const aspect = start.width / start.height;
      if (west || east) height = width / aspect;
      else width = height * aspect;
      if (north) y = bottom - height;
      if (west) x = right - width;
    }

    return {
      x: Math.round(Math.min(x, x + width)),
      y: Math.round(Math.min(y, y + height)),
      width: Math.max(1, Math.round(Math.abs(width))),
      height: Math.max(1, Math.round(Math.abs(height))),
    };
  };

  return {
    id: 'shape',
    name: 'Shape',
    shortcut: 'U',
    cursor: 'crosshair',

    options: [
      {
        type: 'select', id: 'kind', label: 'Shape', default: 'rectangle',
        choices: [
          { value: 'rectangle', label: 'Rectangle' }, { value: 'ellipse', label: 'Ellipse' },
          { value: 'line', label: 'Line' }, { value: 'polygon', label: 'Polygon' },
          { value: 'star', label: 'Star' },
        ],
      },
      { type: 'checkbox', id: 'hasFill', label: 'Fill', default: true },
      { type: 'colour', id: 'strokeColour', label: 'Stroke', default: '#000000' },
      { type: 'number', id: 'strokeWidth', label: 'Width', min: 0, max: 200, default: 0, unit: 'px' },
      {
        type: 'select', id: 'strokeAlign', label: 'Align', default: 'centre',
        choices: [
          { value: 'inside', label: 'Inside' }, { value: 'centre', label: 'Centre' },
          { value: 'outside', label: 'Outside' },
        ],
      },
      { type: 'number', id: 'dash', label: 'Dash', min: 0, max: 100, default: 0, unit: 'px' },
      { type: 'number', id: 'cornerRadius', label: 'Radius', min: 0, max: 500, default: 0, unit: 'px' },
      { type: 'number', id: 'sides', label: 'Sides', min: 3, max: 24, default: 6 },
      { type: 'number', id: 'points', label: 'Points', min: 3, max: 24, default: 5 },
      { type: 'slider', id: 'inset', label: 'Inset', min: 5, max: 95, default: 50, unit: '%' },
      {
        type: 'select', id: 'pathOp', label: 'Path', default: 'new',
        choices: [
          { value: 'new', label: 'New layer' }, { value: 'combine', label: 'Combine' },
          { value: 'subtract', label: 'Subtract' }, { value: 'intersect', label: 'Intersect' },
          { value: 'exclude', label: 'Exclude' },
        ],
      },
    ],

    onPointerDown(context: ToolContext, pointer: ToolPointer): void {
      const existing = editable(context);
      if (existing) {
        const hit = hitHandle(context, existing, pointer.screen);
        if (hit) {
          handle = hit;
          handleStart = pointer.doc;
          startParams = existing.shape!.components[0]!.params;
          return;
        }
      }

      drawing = true;
      anchor = pointer.doc;
      draftLayer = null;
    },

    onPointerMove(context: ToolContext, pointer: ToolPointer): void {
      // ---- editing an existing shape through its handles ----
      if (handle && startParams) {
        const layer = editable(context);
        if (!layer || !layer.shape) return;
        const delta = { x: pointer.doc.x - handleStart.x, y: pointer.doc.y - handleStart.y };

        if (handle === 'rotate') {
          const bounds = shapeBounds(layer.shape);
          const cx = bounds.x + bounds.width / 2;
          const cy = bounds.y + bounds.height / 2;
          const rotation = Math.atan2(pointer.doc.y - cy, pointer.doc.x - cx) + Math.PI / 2;
          applyShapeToLayer(layer, withParams(layer.shape, { rotation }));
        } else if (handle === 'radius') {
          const radius = Math.max(0, Math.round(startParams.cornerRadii[0] + delta.x));
          applyShapeToLayer(layer, withParams(layer.shape, {
            cornerRadii: [radius, radius, radius, radius],
          }));
        } else {
          applyShapeToLayer(layer, withParams(layer.shape,
            resizeParams(handle, startParams, delta, pointer.shiftKey)));
        }

        context.invalidateComposite();
        context.requestRender();
        return;
      }

      if (!drawing) return;

      let width = pointer.doc.x - anchor.x;
      let height = pointer.doc.y - anchor.y;
      if (pointer.shiftKey) {
        // Shift makes it regular: a square, a circle, or a 45 degree line.
        const side = Math.max(Math.abs(width), Math.abs(height));
        width = Math.sign(width || 1) * side;
        height = Math.sign(height || 1) * side;
      }

      let x = anchor.x;
      let y = anchor.y;
      if (pointer.altKey) { x = anchor.x - width; y = anchor.y - height; width *= 2; height *= 2; }

      const rect = {
        x: Math.round(Math.min(x, x + width)),
        y: Math.round(Math.min(y, y + height)),
        width: Math.max(1, Math.round(Math.abs(width))),
        height: Math.max(1, Math.round(Math.abs(height))),
      };

      const kind = context.options.get<string>('kind') as ShapeKind;
      const op = context.options.get<string>('pathOp') as PathOp;
      const style = styleFrom(context);
      const params = paramsFrom(context, rect);

      const target = op !== 'new' ? editable(context) : null;
      if (target && target.shape) {
        // Preview the boolean operation against what is already on the layer.
        const base = draftLayer === target
          ? target.shape.components.slice(0, -1)
          : target.shape.components;
        applyShapeToLayer(target, { ...target.shape, components: [...base, { kind, params, op }] });
        draftLayer = target;
      } else {
        if (!draftLayer) {
          const layer = createLayer({ name: 'Shape', width: 1, height: 1, type: 'shape' });
          context.doc.addLayer(layer);
          context.doc.setActiveLayer(layer.id);
          draftLayer = layer;
        }
        applyShapeToLayer(draftLayer, {
          ...style,
          components: [{ kind, params, op: 'new' }],
        });
      }

      context.invalidateComposite();
      context.requestRender();
    },

    onPointerUp(context: ToolContext): void {
      if (handle) {
        handle = null;
        startParams = null;
        // The whole handle drag is recorded once, from the state before it.
        context.history.transaction('Edit Shape', () => {
          const layer = editable(context);
          if (layer && layer.shape) applyShapeToLayer(layer, layer.shape);
        });
        deps.onChanged();
        return;
      }

      if (!drawing) return;
      drawing = false;

      const layer = draftLayer;
      draftLayer = null;
      if (!layer || !layer.shape) return;

      const bounds = shapeBounds(layer.shape);
      if (bounds.width <= 1 && bounds.height <= 1) {
        context.doc.removeLayer(layer.id);
        context.invalidateComposite();
        return;
      }

      const data = layer.shape;
      context.history.transaction('Shape', () => {
        applyShapeToLayer(layer, data);
      });
      deps.onChanged();
    },

    drawOverlay(ctx: CanvasRenderingContext2D, context: ToolContext): void {
      const layer = editable(context);
      if (!layer || !layer.shape) return;

      const bounds = shapeBounds(layer.shape);
      const topLeft = context.viewport.docToScreen(bounds.x, bounds.y);
      const bottomRight = context.viewport.docToScreen(
        bounds.x + bounds.width, bounds.y + bounds.height,
      );

      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(76, 159, 254, 0.9)';
      ctx.strokeRect(
        Math.round(topLeft.x) + 0.5, Math.round(topLeft.y) + 0.5,
        Math.round(bottomRight.x - topLeft.x), Math.round(bottomRight.y - topLeft.y),
      );
      ctx.setLineDash([]);

      // Everything below is in screen units, so the handles keep the same
      // on-screen size at 25% and at 400%.
      const half = HANDLE_SIZE / 2;
      for (const [id, x, y] of handlePositions(context, layer)) {
        ctx.fillStyle = id === 'radius' ? '#ffd479' : id === 'rotate' ? '#8fe388' : '#ffffff';
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
        ctx.lineWidth = 1;

        if (id === 'rotate' || id === 'radius') {
          ctx.beginPath();
          ctx.arc(x, y, half, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        } else {
          ctx.fillRect(x - half, y - half, HANDLE_SIZE, HANDLE_SIZE);
          ctx.strokeRect(x - half, y - half, HANDLE_SIZE, HANDLE_SIZE);
        }
      }
      ctx.restore();
    },

    deactivate(): void {
      drawing = false;
      handle = null;
      startParams = null;
      draftLayer = null;
    },
  };
}
