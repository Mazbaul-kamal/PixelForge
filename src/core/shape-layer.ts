import type { Layer } from './types';

export type ShapeKind = 'rectangle' | 'ellipse' | 'line' | 'polygon' | 'star' | 'path';
export type PathOp = 'new' | 'combine' | 'subtract' | 'intersect' | 'exclude';
export type StrokeAlign = 'inside' | 'centre' | 'outside';

export interface StrokeStyle {
  readonly colour: string;
  readonly width: number;
  readonly align: StrokeAlign;
  readonly dash: readonly number[];
  readonly cap: CanvasLineCap;
  readonly join: CanvasLineJoin;
}

export interface ShapeParams {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Radians, about the component's own centre. */
  readonly rotation: number;
  /** Top-left, top-right, bottom-right, bottom-left. */
  readonly cornerRadii: readonly [number, number, number, number];
  readonly sides: number;
  readonly points: number;
  /** 0..1, how far the star's inner vertices sit toward the centre. */
  readonly inset: number;
  readonly path: readonly { readonly x: number; readonly y: number }[];
}

export interface ShapeComponent {
  readonly kind: ShapeKind;
  readonly params: ShapeParams;
  /** How this component combines with everything before it. */
  readonly op: PathOp;
}

/**
 * A shape layer stores geometry, exactly as a text layer stores its string.
 * The bitmap is a render of this and is rebuilt whenever anything changes, so
 * a shape can be re-edited at any zoom without ever losing resolution.
 *
 * Immutable, so history snapshots may hold it by reference.
 */
export interface ShapeData {
  readonly components: readonly ShapeComponent[];
  /** Null means no fill. */
  readonly fill: string | null;
  readonly stroke: StrokeStyle;
}

export const DEFAULT_STROKE: StrokeStyle = {
  colour: '#000000',
  width: 0,
  align: 'centre',
  dash: [],
  cap: 'butt',
  join: 'miter',
};

export function defaultParams(x: number, y: number, width: number, height: number): ShapeParams {
  return {
    x, y, width, height,
    rotation: 0,
    cornerRadii: [0, 0, 0, 0],
    sides: 6,
    points: 5,
    inset: 0.5,
    path: [],
  };
}

/** Bounding box of every component, before the stroke is taken into account. */
export function shapeBounds(data: ShapeData): { x: number; y: number; width: number; height: number } {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  for (const component of data.components) {
    const { x, y, width, height, rotation } = component.params;
    if (rotation === 0) {
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x + width);
      bottom = Math.max(bottom, y + height);
      continue;
    }

    // A rotated box needs the extent of its four corners.
    const cx = x + width / 2;
    const cy = y + height / 2;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    for (const [px, py] of [[x, y], [x + width, y], [x + width, y + height], [x, y + height]] as const) {
      const dx = px - cx;
      const dy = py - cy;
      const rx = cx + dx * cos - dy * sin;
      const ry = cy + dx * sin + dy * cos;
      left = Math.min(left, rx);
      top = Math.min(top, ry);
      right = Math.max(right, rx);
      bottom = Math.max(bottom, ry);
    }
  }

  if (!Number.isFinite(left)) return { x: 0, y: 0, width: 1, height: 1 };
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/** Builds the outline of one component, in document coordinates. */
export function componentPath(component: ShapeComponent): Path2D {
  const path = new Path2D();
  const { kind, params } = component;
  const { x, y, width, height } = params;

  const shape = new Path2D();
  switch (kind) {
    case 'rectangle': {
      const [tl, tr, br, bl] = params.cornerRadii;
      const limit = Math.min(width, height) / 2;
      const r = [tl, tr, br, bl].map((value) => Math.max(0, Math.min(value, limit)));

      shape.moveTo(x + r[0]!, y);
      shape.lineTo(x + width - r[1]!, y);
      if (r[1]! > 0) shape.arcTo(x + width, y, x + width, y + r[1]!, r[1]!);
      shape.lineTo(x + width, y + height - r[2]!);
      if (r[2]! > 0) shape.arcTo(x + width, y + height, x + width - r[2]!, y + height, r[2]!);
      shape.lineTo(x + r[3]!, y + height);
      if (r[3]! > 0) shape.arcTo(x, y + height, x, y + height - r[3]!, r[3]!);
      shape.lineTo(x, y + r[0]!);
      if (r[0]! > 0) shape.arcTo(x, y, x + r[0]!, y, r[0]!);
      shape.closePath();
      break;
    }
    case 'ellipse':
      shape.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
      break;
    case 'line':
      shape.moveTo(x, y);
      shape.lineTo(x + width, y + height);
      break;
    case 'polygon': {
      const sides = Math.max(3, Math.round(params.sides));
      for (let i = 0; i < sides; i++) {
        const angle = (i / sides) * Math.PI * 2 - Math.PI / 2;
        const px = x + width / 2 + (Math.cos(angle) * width) / 2;
        const py = y + height / 2 + (Math.sin(angle) * height) / 2;
        if (i === 0) shape.moveTo(px, py);
        else shape.lineTo(px, py);
      }
      shape.closePath();
      break;
    }
    case 'star': {
      const points = Math.max(3, Math.round(params.points));
      const inset = Math.min(0.95, Math.max(0.05, params.inset));
      for (let i = 0; i < points * 2; i++) {
        const angle = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
        const scale = i % 2 === 0 ? 1 : inset;
        const px = x + width / 2 + (Math.cos(angle) * width * scale) / 2;
        const py = y + height / 2 + (Math.sin(angle) * height * scale) / 2;
        if (i === 0) shape.moveTo(px, py);
        else shape.lineTo(px, py);
      }
      shape.closePath();
      break;
    }
    case 'path': {
      const points = params.path;
      if (points.length === 0) break;
      shape.moveTo(points[0]!.x, points[0]!.y);
      for (let i = 1; i < points.length; i++) shape.lineTo(points[i]!.x, points[i]!.y);
      shape.closePath();
      break;
    }
  }

  if (params.rotation === 0) {
    path.addPath(shape);
    return path;
  }

  const cx = x + width / 2;
  const cy = y + height / 2;
  const matrix = new DOMMatrix()
    .translate(cx, cy)
    .rotate((params.rotation * 180) / Math.PI)
    .translate(-cx, -cy);
  path.addPath(shape, matrix);
  return path;
}

const OP_COMPOSITE: Record<PathOp, GlobalCompositeOperation> = {
  new: 'source-over',
  combine: 'source-over',
  subtract: 'destination-out',
  intersect: 'destination-in',
  exclude: 'xor',
};

/** Paints one component's fill and stroke into a context. */
function paintComponent(
  ctx: CanvasRenderingContext2D,
  component: ShapeComponent,
  data: ShapeData,
): void {
  const path = componentPath(component);
  const { stroke } = data;

  if (data.fill && component.kind !== 'line') {
    ctx.fillStyle = data.fill;
    ctx.fill(path);
  }

  if (stroke.width <= 0) return;

  ctx.strokeStyle = stroke.colour;
  ctx.lineCap = stroke.cap;
  ctx.lineJoin = stroke.join;
  ctx.setLineDash([...stroke.dash]);

  // Canvas only strokes down the centre of a path, so the other two
  // alignments are built by stroking double width and trimming one side.
  if (stroke.align === 'centre' || component.kind === 'line') {
    ctx.lineWidth = stroke.width;
    ctx.stroke(path);
    ctx.setLineDash([]);
    return;
  }

  ctx.save();
  ctx.lineWidth = stroke.width * 2;
  if (stroke.align === 'inside') {
    ctx.clip(path);
    ctx.stroke(path);
  } else {
    ctx.stroke(path);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fill(path);
  }
  ctx.restore();
  ctx.setLineDash([]);
}

export interface RenderedShape {
  readonly canvas: HTMLCanvasElement;
  readonly offsetX: number;
  readonly offsetY: number;
}

/** Renders a shape layer's bitmap from its geometry. */
export function renderShape(data: ShapeData): RenderedShape {
  const bounds = shapeBounds(data);
  const pad = Math.ceil(data.stroke.width * 2 + 2);

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(bounds.width) + pad * 2);
  canvas.height = Math.max(1, Math.ceil(bounds.height) + pad * 2);

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not acquire a 2D context to render a shape.');

  ctx.translate(pad - bounds.x, pad - bounds.y);

  const [first, ...rest] = data.components;
  if (!first) return { canvas, offsetX: pad, offsetY: pad };
  paintComponent(ctx, first, data);

  for (const component of rest) {
    if (component.op === 'combine' || component.op === 'new') {
      paintComponent(ctx, component, data);
      continue;
    }

    // The other operations need the component on its own before combining.
    const scratch = document.createElement('canvas');
    scratch.width = canvas.width;
    scratch.height = canvas.height;
    const scratchCtx = scratch.getContext('2d');
    if (!scratchCtx) continue;

    scratchCtx.translate(pad - bounds.x, pad - bounds.y);
    paintComponent(scratchCtx, component, data);

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = OP_COMPOSITE[component.op];
    ctx.drawImage(scratch, 0, 0);
    ctx.restore();
  }

  return { canvas, offsetX: pad, offsetY: pad };
}

/** Re-renders a shape layer in place. */
export function applyShapeToLayer(layer: Layer, data: ShapeData): void {
  const bounds = shapeBounds(data);
  const rendered = renderShape(data);

  layer.canvas = rendered.canvas;
  const ctx = rendered.canvas.getContext('2d');
  if (ctx) layer.ctx = ctx;

  layer.shape = data;
  layer.type = 'shape';
  layer.x = Math.round(bounds.x - rendered.offsetX);
  layer.y = Math.round(bounds.y - rendered.offsetY);
}
