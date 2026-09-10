import { fromQuad, multiply, rectCorners, rotate, scale, skew, translate } from '../core/matrix3';
import type { Matrix3 } from '../core/matrix3';
import { canEditLayer } from '../core/layer-ops';
import { captureLayerPixels, restoreLayerPixels } from '../core/snapshot';
import type { PixelSnapshot } from '../core/snapshot';
import { renderTransform } from '../core/transform-render';
import type { Layer, Point } from '../core/types';
import { apply } from '../core/matrix3';
import type { Tool, ToolContext, ToolPointer } from './types';

const HANDLE_SIZE = 8;
const HANDLE_HIT = 10;
/** How far outside a corner the rotation zone reaches. */
const ROTATE_ZONE = 26;

type Corner = 0 | 1 | 2 | 3;
type HandleId =
  | { kind: 'corner'; index: Corner }
  | { kind: 'edge'; index: Corner }
  | { kind: 'rotate'; index: Corner }
  | { kind: 'origin' }
  | { kind: 'move' }
  | null;

interface AffineState {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  angle: number;
  skewX: number;
  skewY: number;
}

export interface TransformDeps {
  onChanged: () => void;
  /** Returns to whichever tool was active before the transform began. */
  onExit: () => void;
}

/**
 * Free transform.
 *
 * Everything is one 3x3 matrix: scale, rotate and skew move the affine part,
 * distort and perspective move the destination corners, and the matrix is
 * always solved from the source rectangle to those four corners.
 *
 * The ORIGINAL bitmap is kept for the whole session and every preview is
 * rendered from it, so scaling down and back up costs exactly one resample
 * rather than degrading a little each time.
 */
export function createTransformTool(deps: TransformDeps): Tool {
  let layer: Layer | null = null;
  let source: HTMLCanvasElement | null = null;
  let sourceOrigin: Point = { x: 0, y: 0 };
  let before: PixelSnapshot | null = null;
  let beforePosition: Point = { x: 0, y: 0 };

  let affine: AffineState = { x: 0, y: 0, scaleX: 1, scaleY: 1, angle: 0, skewX: 0, skewY: 0 };
  /** Extra per-corner displacement, which is what distort and perspective use. */
  let cornerOffsets: Point[] = [];
  /** Transform origin, in source-bitmap coordinates. */
  let origin: Point = { x: 0, y: 0 };

  let active: HandleId = null;
  let dragFrom: Point = { x: 0, y: 0 };
  let startAffine: AffineState | null = null;
  let startCorners: Point[] = [];
  let startAngle = 0;

  const resetOffsets = (): void => {
    cornerOffsets = [
      { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 },
    ];
  };

  /** The affine part as a matrix, in source-bitmap coordinates. */
  const affineMatrix = (state: AffineState): Matrix3 => {
    let m = translate(sourceOrigin.x + state.x, sourceOrigin.y + state.y);
    m = multiply(m, translate(origin.x, origin.y));
    m = multiply(m, rotate(state.angle));
    m = multiply(m, skew(state.skewX, state.skewY));
    m = multiply(m, scale(state.scaleX, state.scaleY));
    m = multiply(m, translate(-origin.x, -origin.y));
    return m;
  };

  const destinationCorners = (state = affine): Point[] => {
    if (!source) return [];
    const m = affineMatrix(state);
    return rectCorners(0, 0, source.width, source.height).map((corner, index) => {
      const mapped = apply(m, corner.x, corner.y);
      const offset = cornerOffsets[index] ?? { x: 0, y: 0 };
      return { x: mapped.x + offset.x, y: mapped.y + offset.y };
    });
  };

  const currentMatrix = (): Matrix3 | null => {
    if (!source) return null;
    return fromQuad(rectCorners(0, 0, source.width, source.height), destinationCorners());
  };

  /** Renders the preview from the original into the layer's own canvas. */
  const refresh = (context: ToolContext): void => {
    if (!layer || !source) return;
    const matrix = currentMatrix();
    if (!matrix) return;

    const rendered = renderTransform(source, matrix, { quality: 'high' });

    // Written into the existing canvas rather than replacing it: history
    // snapshots hold layer bitmaps by reference and rely on that identity.
    layer.canvas.width = rendered.canvas.width;
    layer.canvas.height = rendered.canvas.height;
    layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
    layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    layer.ctx.drawImage(rendered.canvas, 0, 0);
    layer.x = rendered.x;
    layer.y = rendered.y;

    context.invalidateComposite();
    context.requestRender();
  };

  const begin = (context: ToolContext): boolean => {
    const target = context.activeLayer;
    if (!canEditLayer(target) || !target) return false;

    layer = target;
    before = captureLayerPixels(target);
    beforePosition = { x: target.x, y: target.y };
    sourceOrigin = { x: target.x, y: target.y };

    const clone = document.createElement('canvas');
    clone.width = target.canvas.width;
    clone.height = target.canvas.height;
    clone.getContext('2d')?.drawImage(target.canvas, 0, 0);
    source = clone;

    affine = { x: 0, y: 0, scaleX: 1, scaleY: 1, angle: 0, skewX: 0, skewY: 0 };
    resetOffsets();
    origin = { x: clone.width / 2, y: clone.height / 2 };
    return true;
  };

  const commit = (context: ToolContext): void => {
    const target = layer;
    const start = before;
    layer = null;
    source = null;
    before = null;
    active = null;

    if (!target || !start) return;

    const doc = context.doc;
    const after = captureLayerPixels(target);
    const finalPosition = { x: target.x, y: target.y };
    const originalPosition = beforePosition;

    context.history.push(
      'Free Transform',
      () => {
        restoreLayerPixels(doc, start);
        const l = doc.getLayer(start.layerId);
        if (l) { l.x = originalPosition.x; l.y = originalPosition.y; }
      },
      () => {
        restoreLayerPixels(doc, after);
        const l = doc.getLayer(after.layerId);
        if (l) { l.x = finalPosition.x; l.y = finalPosition.y; }
      },
    );
    deps.onChanged();
    context.invalidateComposite();
  };

  const cancel = (context: ToolContext): void => {
    const target = layer;
    const start = before;
    layer = null;
    source = null;
    before = null;
    active = null;

    if (!target || !start) return;
    restoreLayerPixels(context.doc, start);
    target.x = beforePosition.x;
    target.y = beforePosition.y;
    context.invalidateComposite();
    context.requestRender();
  };

  const handlesOnScreen = (context: ToolContext): { id: HandleId; x: number; y: number }[] => {
    const corners = destinationCorners();
    if (corners.length < 4) return [];

    const screen = corners.map((c) => context.viewport.docToScreen(c.x, c.y));
    const spots: { id: HandleId; x: number; y: number }[] = [];

    screen.forEach((point, index) => {
      spots.push({ id: { kind: 'corner', index: index as Corner }, x: point.x, y: point.y });
    });
    for (let i = 0; i < 4; i++) {
      const a = screen[i]!;
      const b = screen[(i + 1) % 4]!;
      spots.push({
        id: { kind: 'edge', index: i as Corner },
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
      });
    }

    if (source) {
      const m = affineMatrix(affine);
      const point = apply(m, origin.x, origin.y);
      const onScreen = context.viewport.docToScreen(point.x, point.y);
      spots.push({ id: { kind: 'origin' }, x: onScreen.x, y: onScreen.y });
    }
    return spots;
  };

  const hitTest = (context: ToolContext, at: Point): HandleId => {
    const spots = handlesOnScreen(context);
    for (const spot of spots) {
      if (Math.hypot(at.x - spot.x, at.y - spot.y) <= HANDLE_HIT) return spot.id;
    }
    // Just outside a corner is the rotation zone.
    for (const spot of spots) {
      if (spot.id?.kind !== 'corner') continue;
      const distance = Math.hypot(at.x - spot.x, at.y - spot.y);
      if (distance <= ROTATE_ZONE) return { kind: 'rotate', index: spot.id.index };
    }
    return { kind: 'move' };
  };

  const centreOfQuad = (): Point => {
    const corners = destinationCorners();
    const sum = corners.reduce((a, c) => ({ x: a.x + c.x, y: a.y + c.y }), { x: 0, y: 0 });
    return { x: sum.x / corners.length, y: sum.y / corners.length };
  };

  return {
    id: 'transform',
    name: 'Free Transform',
    shortcut: 'Y',
    cursor: 'default',

    options: [
      { type: 'number', id: 'x', label: 'X', min: -20000, max: 20000, default: 0, unit: 'px' },
      { type: 'number', id: 'y', label: 'Y', min: -20000, max: 20000, default: 0, unit: 'px' },
      { type: 'number', id: 'width', label: 'W', min: 1, max: 2000, default: 100, unit: '%' },
      { type: 'number', id: 'height', label: 'H', min: 1, max: 2000, default: 100, unit: '%' },
      { type: 'number', id: 'angle', label: 'Angle', min: -360, max: 360, default: 0, unit: '°' },
      { type: 'number', id: 'skewX', label: 'Skew', min: -80, max: 80, default: 0, unit: '°' },
      {
        type: 'select', id: 'reference', label: 'Origin', default: 'centre',
        choices: [
          { value: 'centre', label: 'Centre' }, { value: 'nw', label: 'Top left' },
          { value: 'ne', label: 'Top right' }, { value: 'se', label: 'Bottom right' },
          { value: 'sw', label: 'Bottom left' },
        ],
      },
      {
        type: 'button', id: 'flipH', label: '⇄', title: 'Flip horizontal',
        run: (context) => { affine = { ...affine, scaleX: -affine.scaleX }; refresh(context); },
      },
      {
        type: 'button', id: 'flipV', label: '⇅', title: 'Flip vertical',
        run: (context) => { affine = { ...affine, scaleY: -affine.scaleY }; refresh(context); },
      },
      {
        type: 'button', id: 'rotateCcw', label: '⟲', title: 'Rotate 90° anticlockwise',
        run: (context) => { affine = { ...affine, angle: affine.angle - Math.PI / 2 }; refresh(context); },
      },
      {
        type: 'button', id: 'rotateCw', label: '⟳', title: 'Rotate 90° clockwise',
        run: (context) => { affine = { ...affine, angle: affine.angle + Math.PI / 2 }; refresh(context); },
      },
      {
        type: 'button', id: 'apply', label: '✓', title: 'Apply (Enter)',
        run: (context) => { commit(context); deps.onExit(); },
      },
    ],

    activate(context: ToolContext): void {
      if (!begin(context)) return;
      context.requestRender();
    },

    onPointerDown(context: ToolContext, pointer: ToolPointer): void {
      if (!layer) return;
      active = hitTest(context, pointer.screen);
      dragFrom = pointer.doc;
      startAffine = { ...affine };
      startCorners = destinationCorners().map((c) => ({ ...c }));

      const centre = centreOfQuad();
      startAngle = Math.atan2(pointer.doc.y - centre.y, pointer.doc.x - centre.x);
    },

    onPointerMove(context: ToolContext, pointer: ToolPointer): void {
      if (!layer || !active || !startAffine || !source) return;

      const delta = { x: pointer.doc.x - dragFrom.x, y: pointer.doc.y - dragFrom.y };
      const distort = pointer.ctrlKey || pointer.metaKey;

      if (active.kind === 'move') {
        affine = { ...startAffine, x: startAffine.x + delta.x, y: startAffine.y + delta.y };
      } else if (active.kind === 'origin') {
        origin = { x: pointer.doc.x - sourceOrigin.x, y: pointer.doc.y - sourceOrigin.y };
      } else if (active.kind === 'rotate') {
        const centre = centreOfQuad();
        let angle = Math.atan2(pointer.doc.y - centre.y, pointer.doc.x - centre.x) - startAngle;
        // Shift snaps rotation to 15 degree steps.
        if (pointer.shiftKey) angle = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
        affine = { ...startAffine, angle: startAffine.angle + angle };
      } else if (active.kind === 'corner' && distort) {
        const index = active.index;
        if (pointer.altKey && pointer.shiftKey) {
          // Perspective: the corner and its neighbour on the same edge move
          // apart symmetrically, which keeps the opposite edge straight.
          const partner = ((index % 2 === 0 ? index + 3 : index + 1) % 4) as Corner;
          cornerOffsets[index] = { x: delta.x, y: delta.y };
          cornerOffsets[partner] = { x: -delta.x, y: -delta.y };
        } else {
          cornerOffsets[index] = { x: delta.x, y: delta.y };
        }
      } else if (active.kind === 'edge' && distort && pointer.shiftKey) {
        // Skew: slide the whole edge along its own direction.
        const from = startCorners[active.index]!;
        const to = startCorners[(active.index + 1) % 4]!;
        const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
        const ux = (to.x - from.x) / length;
        const uy = (to.y - from.y) / length;
        const along = delta.x * ux + delta.y * uy;
        const shift = { x: ux * along, y: uy * along };
        cornerOffsets[active.index] = shift;
        cornerOffsets[((active.index + 1) % 4) as Corner] = shift;
      } else if (active.kind === 'corner' || active.kind === 'edge') {
        // Plain scaling, in the transform's own frame.
        const inverseAngle = -startAffine.angle;
        const cos = Math.cos(inverseAngle);
        const sin = Math.sin(inverseAngle);
        const local = { x: delta.x * cos - delta.y * sin, y: delta.x * sin + delta.y * cos };

        const width = source.width * startAffine.scaleX || 1;
        const height = source.height * startAffine.scaleY || 1;
        const index = active.index;

        const horizontal = active.kind === 'corner' || index === 1 || index === 3;
        const vertical = active.kind === 'corner' || index === 0 || index === 2;
        const signX = index === 1 || index === 2 ? 1 : -1;
        const signY = index === 2 || index === 3 ? 1 : -1;

        let scaleX = horizontal ? startAffine.scaleX + (signX * local.x) / source.width : startAffine.scaleX;
        let scaleY = vertical ? startAffine.scaleY + (signY * local.y) / source.height : startAffine.scaleY;

        if (pointer.shiftKey && active.kind === 'corner') {
          const ratio = Math.abs(scaleX / (startAffine.scaleX || 1));
          scaleY = startAffine.scaleY * ratio * Math.sign(scaleY || 1);
        }
        void width;
        void height;

        affine = { ...startAffine, scaleX, scaleY };
      }

      refresh(context);
    },

    onPointerUp(): void {
      active = null;
      startAffine = null;
    },

    onKeyDown(context: ToolContext, event: KeyboardEvent): boolean {
      if (!layer) return false;

      if (event.key === 'Enter') {
        commit(context);
        deps.onExit();
        return true;
      }
      if (event.key === 'Escape') {
        cancel(context);
        deps.onExit();
        return true;
      }

      const step = event.shiftKey ? 10 : 1;
      const nudge: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0], ArrowRight: [step, 0],
        ArrowUp: [0, -step], ArrowDown: [0, step],
      };
      const move = nudge[event.key];
      if (!move) return false;

      affine = { ...affine, x: affine.x + move[0], y: affine.y + move[1] };
      refresh(context);
      return true;
    },

    drawOverlay(ctx: CanvasRenderingContext2D, context: ToolContext): void {
      if (!layer || !source) return;

      const corners = destinationCorners().map((c) => context.viewport.docToScreen(c.x, c.y));
      if (corners.length < 4) return;

      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(76, 159, 254, 0.95)';
      ctx.beginPath();
      ctx.moveTo(corners[0]!.x, corners[0]!.y);
      for (let i = 1; i < 4; i++) ctx.lineTo(corners[i]!.x, corners[i]!.y);
      ctx.closePath();
      ctx.stroke();

      const half = HANDLE_SIZE / 2;
      for (const spot of handlesOnScreen(context)) {
        if (spot.id?.kind === 'origin') {
          ctx.beginPath();
          ctx.arc(spot.x, spot.y, 6, 0, Math.PI * 2);
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(spot.x - 8, spot.y);
          ctx.lineTo(spot.x + 8, spot.y);
          ctx.moveTo(spot.x, spot.y - 8);
          ctx.lineTo(spot.x, spot.y + 8);
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
          ctx.lineWidth = 1;
          ctx.stroke();
          continue;
        }
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
        ctx.lineWidth = 1;
        ctx.fillRect(spot.x - half, spot.y - half, HANDLE_SIZE, HANDLE_SIZE);
        ctx.strokeRect(spot.x - half, spot.y - half, HANDLE_SIZE, HANDLE_SIZE);
      }
      ctx.restore();
    },

    deactivate(context: ToolContext): void {
      if (layer) commit(context);
    },
  };
}
