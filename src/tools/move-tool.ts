import type { PixelDocument } from '../core/document';
import type { Transaction } from '../core/history';
import { alignLayerToDocument, canEditLayer, cloneLayerAbove } from '../core/layer-ops';
import type { AlignEdge } from '../core/layer-ops';
import { captureLayerPixels, restoreLayerPixels } from '../core/snapshot';
import type { PixelSnapshot } from '../core/snapshot';
import { collectSnapTargets, computeSnap, guideSnapTargets, layerRect } from '../core/snapping';
import type { GuideSettings } from '../core/guides';
import type { Guide } from '../core/snapping';
import type { SelectionMask } from '../core/selection';
import type { Layer, Point } from '../core/types';
import type { Tool, ToolContext, ToolPointer } from './types';

/** Screen pixels within which an edge is considered aligned. */
const SNAP_THRESHOLD_PX = 6;
/** Consecutive nudges closer together than this become one history entry. */
const NUDGE_COALESCE_MS = 600;
const ALPHA_HIT_THRESHOLD = 8;

const GUIDE_COLOUR = '#ff2fd0';
const OUTLINE_COLOUR = 'rgba(255, 255, 255, 0.85)';
const OUTLINE_SHADOW = 'rgba(0, 0, 0, 0.65)';
const MARKER_SIZE = 6;

/** Pixels lifted out of a layer by a selection, being dragged around. */
interface FloatingRegion {
  readonly layerId: string;
  readonly canvas: HTMLCanvasElement;
  /** Where the region was cut from, in document coordinates. */
  readonly origin: Point;
  /** Layer bitmap as it was before the cut, for one clean undo. */
  readonly before: PixelSnapshot;
  offset: Point;
}

function alignButton(id: string, label: string, title: string, edge: AlignEdge) {
  return {
    type: 'button' as const,
    id,
    label,
    title,
    run: (context: ToolContext): void => {
      const active = context.doc.activeLayerId;
      if (active) alignLayerToDocument(context.doc, context.history, active, edge);
    },
  };
}

/** Topmost visible layer with a solid enough pixel under the point. */
function pickLayer(doc: PixelDocument, point: Point): Layer | null {
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const layer = doc.layers[i]!;
    if (!layer.visible) continue;

    const x = Math.floor(point.x - layer.x);
    const y = Math.floor(point.y - layer.y);
    if (x < 0 || y < 0 || x >= layer.canvas.width || y >= layer.canvas.height) continue;

    const alpha = layer.ctx.getImageData(x, y, 1, 1).data[3] ?? 0;
    if (alpha > ALPHA_HIT_THRESHOLD) return layer;
  }
  return null;
}

/** Constrains a drag to horizontal, vertical or 45 degrees. */
function constrain(dx: number, dy: number): Point {
  const length = Math.hypot(dx, dy);
  if (length === 0) return { x: 0, y: 0 };

  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: Math.cos(angle) * length, y: Math.sin(angle) * length };
}

export interface MoveDeps {
  /** Read live, so toggling guides or the grid takes effect immediately. */
  readonly guideSettings: () => GuideSettings;
}

export function createMoveTool(deps: MoveDeps): Tool {
  let dragging = false;
  let startDoc: Point = { x: 0, y: 0 };
  let startLayer: Point = { x: 0, y: 0 };
  let moveTx: Transaction | null = null;
  let guides: readonly Guide[] = [];
  let floating: FloatingRegion | null = null;

  let nudgeTx: Transaction | null = null;
  let nudgeTimer = 0;

  const commitNudge = (): void => {
    if (nudgeTimer !== 0) window.clearTimeout(nudgeTimer);
    nudgeTimer = 0;
    const transaction = nudgeTx;
    nudgeTx = null;
    transaction?.commit();
  };

  /** Lifts the selected pixels out of the layer so they can be dragged. */
  const beginFloat = (layer: Layer, selection: SelectionMask): FloatingRegion => {
    const bounds = selection.bounds();
    const before = captureLayerPixels(layer);

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bounds.width));
    canvas.height = Math.max(1, Math.round(bounds.height));
    const ctx = canvas.getContext('2d')!;

    // Copy the layer through the selection mask.
    ctx.drawImage(layer.canvas, layer.x - bounds.x, layer.y - bounds.y);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(selection.canvas, -bounds.x, -bounds.y);
    ctx.globalCompositeOperation = 'source-over';

    // Erase them from the layer.
    layer.ctx.save();
    layer.ctx.globalCompositeOperation = 'destination-out';
    layer.ctx.drawImage(selection.canvas, -layer.x, -layer.y);
    layer.ctx.restore();

    return { layerId: layer.id, canvas, origin: { x: bounds.x, y: bounds.y }, before, offset: { x: 0, y: 0 } };
  };

  /** Stamps a floating region back down as a single history entry. */
  const commitFloat = (context: ToolContext): void => {
    const region = floating;
    floating = null;
    if (!region) return;

    const layer = context.doc.getLayer(region.layerId);
    if (!layer) return;

    layer.ctx.drawImage(
      region.canvas,
      region.origin.x + region.offset.x - layer.x,
      region.origin.y + region.offset.y - layer.y,
    );

    const after = captureLayerPixels(layer);
    const { before } = region;
    const doc = context.doc;
    context.history.push(
      'Move Selected Pixels',
      () => restoreLayerPixels(doc, before),
      () => restoreLayerPixels(doc, after),
    );
    context.invalidateComposite();
  };

  const nudge = (context: ToolContext, dx: number, dy: number): void => {
    const layer = context.activeLayer;
    if (!canEditLayer(layer) || !layer) return;

    nudgeTx ??= context.history.beginStructural('Move Layer');
    layer.x += dx;
    layer.y += dy;
    context.invalidateComposite();

    if (nudgeTimer !== 0) window.clearTimeout(nudgeTimer);
    nudgeTimer = window.setTimeout(commitNudge, NUDGE_COALESCE_MS);
  };

  return {
    id: 'move',
    name: 'Move',
    shortcut: 'V',
    cursor: 'move',

    options: [
      { type: 'checkbox', id: 'autoSelect', label: 'Auto-select layer', default: false },
      { type: 'checkbox', id: 'movePixels', label: 'Move selected pixels', default: true },
      { type: 'checkbox', id: 'snap', label: 'Snap', default: true },
      alignButton('alignLeft', '⇤', 'Align left edges', 'left'),
      alignButton('alignCentre', '⇹', 'Align horizontal centres', 'centre'),
      alignButton('alignRight', '⇥', 'Align right edges', 'right'),
      alignButton('alignTop', '⤒', 'Align top edges', 'top'),
      alignButton('alignMiddle', '⇳', 'Align vertical centres', 'middle'),
      alignButton('alignBottom', '⤓', 'Align bottom edges', 'bottom'),
    ],

    onPointerDown(context: ToolContext, pointer: ToolPointer): void {
      commitNudge();

      if (context.options.get<boolean>('autoSelect')) {
        const hit = pickLayer(context.doc, pointer.doc);
        if (hit) context.doc.setActiveLayer(hit.id);
      }

      const layer = context.activeLayer;
      if (!canEditLayer(layer) || !layer) return;

      dragging = true;
      startDoc = pointer.doc;
      guides = [];

      const selection = context.selection;
      if (selection && context.options.get<boolean>('movePixels')) {
        // A fresh selection lifts its pixels; an existing float keeps moving.
        if (!floating || floating.layerId !== layer.id) {
          commitFloat(context);
          floating = beginFloat(layer, selection);
        }
        startLayer = { ...floating.offset };
        context.invalidateComposite();
        return;
      }

      moveTx = context.history.beginStructural(pointer.altKey ? 'Duplicate and Move' : 'Move Layer');

      if (pointer.altKey) {
        const copy = cloneLayerAbove(context.doc, layer.id);
        if (copy) context.doc.setActiveLayer(copy.id);
      }

      const target = context.activeLayer;
      startLayer = target ? { x: target.x, y: target.y } : { x: 0, y: 0 };
    },

    onPointerMove(context: ToolContext, pointer: ToolPointer): void {
      if (!dragging) return;

      let dx = pointer.doc.x - startDoc.x;
      let dy = pointer.doc.y - startDoc.y;
      if (pointer.shiftKey) ({ x: dx, y: dy } = constrain(dx, dy));

      if (floating) {
        floating.offset = { x: Math.round(startLayer.x + dx), y: Math.round(startLayer.y + dy) };
        guides = [];
        context.requestRender();
        return;
      }

      const layer = context.activeLayer;
      if (!layer) return;

      let x = Math.round(startLayer.x + dx);
      let y = Math.round(startLayer.y + dy);

      // Ctrl suspends snapping, matching every other editor.
      const snapEnabled = context.options.get<boolean>('snap')
        && deps.guideSettings().snap && !pointer.ctrlKey && !pointer.metaKey;
      if (snapEnabled) {
        const rect = { ...layerRect(layer), x, y };
        const targets = [
          ...collectSnapTargets(context.doc, layer.id),
          ...guideSnapTargets(context.doc, deps.guideSettings()),
        ];
        const outcome = computeSnap(rect, targets, SNAP_THRESHOLD_PX / context.viewport.zoom);
        x = Math.round(x + outcome.dx);
        y = Math.round(y + outcome.dy);
        guides = outcome.guides;
      } else {
        guides = [];
      }

      if (layer.x === x && layer.y === y) return;
      layer.x = x;
      layer.y = y;
      context.invalidateComposite();
    },

    onPointerUp(context: ToolContext): void {
      const layer = context.activeLayer;
      if (dragging && layer?.mask && layer.maskLinked === false) {
        // An unlinked mask holds its place in the document, so its content is
        // shifted back by however far the layer travelled.
        const dx = layer.x - startLayer.x;
        const dy = layer.y - startLayer.y;
        if (dx !== 0 || dy !== 0) shiftMask(layer.mask, -dx, -dy);
      }

      dragging = false;
      guides = [];

      const transaction = moveTx;
      moveTx = null;
      transaction?.commit();
      context.requestRender();
    },

    onKeyDown(context: ToolContext, event: KeyboardEvent): boolean {
      const step = event.shiftKey ? 10 : 1;
      switch (event.key) {
        case 'ArrowLeft':
          nudge(context, -step, 0);
          return true;
        case 'ArrowRight':
          nudge(context, step, 0);
          return true;
        case 'ArrowUp':
          nudge(context, 0, -step);
          return true;
        case 'ArrowDown':
          nudge(context, 0, step);
          return true;
        default:
          return false;
      }
    },

    drawOverlay(ctx: CanvasRenderingContext2D, context: ToolContext): void {
      const { viewport } = context;

      // Magenta smart guides for whatever the drag is currently aligned to.
      if (guides.length > 0) {
        ctx.save();
        ctx.strokeStyle = GUIDE_COLOUR;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const guide of guides) {
          if (guide.axis === 'x') {
            const start = viewport.docToScreen(guide.position, guide.from);
            const end = viewport.docToScreen(guide.position, guide.to);
            const x = Math.round(start.x) + 0.5;
            ctx.moveTo(x, start.y);
            ctx.lineTo(x, end.y);
          } else {
            const start = viewport.docToScreen(guide.from, guide.position);
            const end = viewport.docToScreen(guide.to, guide.position);
            const y = Math.round(start.y) + 0.5;
            ctx.moveTo(start.x, y);
            ctx.lineTo(end.x, y);
          }
        }
        ctx.stroke();
        ctx.restore();
      }

      if (floating) {
        const at = viewport.docToScreen(
          floating.origin.x + floating.offset.x,
          floating.origin.y + floating.offset.y,
        );
        ctx.save();
        ctx.imageSmoothingEnabled = viewport.zoom <= 1;
        ctx.drawImage(
          floating.canvas,
          at.x,
          at.y,
          floating.canvas.width * viewport.zoom,
          floating.canvas.height * viewport.zoom,
        );
        ctx.restore();
      }

      const layer = context.activeLayer;
      if (!layer) return;

      const topLeft = viewport.docToScreen(layer.x, layer.y);
      const bottomRight = viewport.docToScreen(
        layer.x + layer.canvas.width,
        layer.y + layer.canvas.height,
      );
      const x = Math.round(topLeft.x) + 0.5;
      const y = Math.round(topLeft.y) + 0.5;
      const width = Math.round(bottomRight.x) - Math.round(topLeft.x);
      const height = Math.round(bottomRight.y) - Math.round(topLeft.y);

      ctx.save();
      // A dark underlay keeps the dashes legible over any image.
      ctx.lineWidth = 1;
      ctx.strokeStyle = OUTLINE_SHADOW;
      ctx.setLineDash([]);
      ctx.strokeRect(x, y, width, height);

      ctx.strokeStyle = OUTLINE_COLOUR;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x, y, width, height);
      ctx.setLineDash([]);

      // Eight markers so the extent reads at a glance. Not interactive here;
      // the free transform step makes handles that do something.
      const half = MARKER_SIZE / 2;
      const columns = [x, x + width / 2, x + width];
      const rows = [y, y + height / 2, y + height];
      ctx.fillStyle = OUTLINE_COLOUR;
      ctx.strokeStyle = OUTLINE_SHADOW;
      for (const cx of columns) {
        for (const cy of rows) {
          if (cx === columns[1] && cy === rows[1]) continue;
          ctx.fillRect(cx - half, cy - half, MARKER_SIZE, MARKER_SIZE);
          ctx.strokeRect(cx - half, cy - half, MARKER_SIZE, MARKER_SIZE);
        }
      }
      ctx.restore();
    },

    deactivate(context: ToolContext): void {
      dragging = false;
      guides = [];
      commitNudge();
      const transaction = moveTx;
      moveTx = null;
      transaction?.commit();
      // Leaving the tool commits any pixels still floating.
      commitFloat(context);
    },
  };
}

/** Moves a mask's content inside its own canvas. */
function shiftMask(mask: HTMLCanvasElement, dx: number, dy: number): void {
  const ctx = mask.getContext('2d');
  if (!ctx) return;

  const copy = document.createElement('canvas');
  copy.width = mask.width;
  copy.height = mask.height;
  copy.getContext('2d')?.drawImage(mask, 0, 0);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, mask.width, mask.height);
  ctx.drawImage(copy, Math.round(dx), Math.round(dy));
}
