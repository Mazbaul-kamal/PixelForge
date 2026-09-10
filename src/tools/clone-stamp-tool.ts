import { createLayer } from '../core/layer';
import { captureLayerPixels, restoreLayerPixels } from '../core/snapshot';
import { StrokeEngine } from '../core/stroke-engine';
import type { Point } from '../core/types';
import {
  drawCursorOutline, paintableSurface, readBrushSettings, stepBrushSize, strokeOptions,
  toBufferSample,
} from './stroke-tool';
import type { PaintSurface } from './stroke-tool';
import type { Tool, ToolContext, ToolPointer } from './types';

export interface CloneDeps {
  onChanged: () => void;
  notify: (title: string, detail?: string) => void;
}

/**
 * Clone stamp. The stroke engine paints a plain alpha mask, and the source
 * pixels are drawn through it, so the soft dab edges blend the copy in and
 * overlapping dabs cannot build a seam.
 */
export function createCloneStampTool(deps: CloneDeps): Tool {
  /** Where Alt+click set the source, in document coordinates. */
  let sourcePoint: Point | null = null;
  /** Offset from the painted point to the sampled point. */
  let offset: Point | null = null;
  let hover: Point | null = null;

  let engine: StrokeEngine | null = null;
  let alphaBuffer: HTMLCanvasElement | null = null;
  let cloneBuffer: HTMLCanvasElement | null = null;
  let sourceImage: HTMLCanvasElement | null = null;
  let target: PaintSurface | null = null;

  /** Snapshot of what we are cloning FROM, taken before the stroke starts. */
  const captureSource = (context: ToolContext): HTMLCanvasElement | null => {
    const data = context.readSourcePixels(context.options.get<boolean>('sampleAllLayers'));
    if (!data) return null;

    const canvas = document.createElement('canvas');
    canvas.width = data.width;
    canvas.height = data.height;
    canvas.getContext('2d')?.putImageData(data, 0, 0);
    return canvas;
  };

  const refreshCloneBuffer = (context: ToolContext): void => {
    if (!cloneBuffer || !alphaBuffer || !sourceImage || !target || !offset) return;

    const ctx = cloneBuffer.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, cloneBuffer.width, cloneBuffer.height);
    // A point p must copy from p + offset, and drawImage placed at d makes
    // p read source(p - d), so the image goes down at -offset.
    ctx.drawImage(sourceImage, -(target.layer.x + offset.x), -(target.layer.y + offset.y));
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(alphaBuffer, 0, 0);
    ctx.globalCompositeOperation = 'source-over';

    context.setLiveStroke({
      layerId: target.layer.id,
      canvas: cloneBuffer,
      opacity: context.options.get<number>('opacity') / 100,
      composite: 'source-over',
      target: target.isMask ? 'mask' : 'layer',
    });
  };

  const endStroke = (context: ToolContext): void => {
    const surface = target;
    const buffer = cloneBuffer;
    const painted = engine?.hasPainted ?? false;

    engine = null;
    alphaBuffer = null;
    cloneBuffer = null;
    sourceImage = null;
    target = null;
    context.setLiveStroke(null);

    if (!surface || !buffer || !painted) {
      context.invalidateComposite();
      return;
    }

    const doc = context.doc;
    const kind = surface.isMask ? 'mask' : 'layer';
    const before = captureLayerPixels(surface.layer, kind);
    surface.ctx.save();
    surface.ctx.globalAlpha = Math.min(1, Math.max(0, context.options.get<number>('opacity') / 100));
    surface.ctx.drawImage(buffer, 0, 0);
    surface.ctx.restore();

    const after = captureLayerPixels(surface.layer, kind);
    context.history.push(
      'Clone Stamp',
      () => restoreLayerPixels(doc, before),
      () => restoreLayerPixels(doc, after),
    );
    deps.onChanged();
    context.invalidateComposite();
  };

  return {
    id: 'clone-stamp',
    name: 'Clone Stamp',
    shortcut: 'S',
    cursor: 'none',

    options: [
      ...strokeOptions(),
      { type: 'checkbox', id: 'aligned', label: 'Aligned', default: true },
      { type: 'checkbox', id: 'sampleAllLayers', label: 'Sample all layers', default: false },
      { type: 'checkbox', id: 'cloneToNewLayer', label: 'Clone to a new layer', default: false },
    ],

    onPointerDown(context: ToolContext, pointer: ToolPointer): void {
      if (pointer.altKey) {
        // Alt+click sets where the copy comes from.
        sourcePoint = pointer.doc;
        offset = null;
        deps.notify('Clone source set.');
        context.requestRender();
        return;
      }

      if (!sourcePoint) {
        deps.notify('Set a clone source first.', 'Alt+click the area you want to copy from.');
        return;
      }

      sourceImage = captureSource(context);
      if (!sourceImage) return;

      // Unaligned starts from the original source every stroke; aligned keeps
      // whatever offset was established the first time.
      if (!context.options.get<boolean>('aligned') || !offset) {
        offset = { x: sourcePoint.x - pointer.doc.x, y: sourcePoint.y - pointer.doc.y };
      }

      let surface = paintableSurface(context);
      if (!surface) return;

      if (context.options.get<boolean>('cloneToNewLayer')) {
        const fresh = createLayer({
          name: 'Clone', width: context.doc.width, height: context.doc.height,
        });
        const base = surface.layer;
        context.history.transaction('Clone Layer', () => {
          context.doc.addLayer(fresh, context.doc.indexOfLayer(base.id) + 1);
          context.doc.setActiveLayer(fresh.id);
        });
        surface = { layer: fresh, canvas: fresh.canvas, ctx: fresh.ctx, isMask: false };
        deps.onChanged();
      }

      target = surface;
      alphaBuffer = document.createElement('canvas');
      alphaBuffer.width = surface.canvas.width;
      alphaBuffer.height = surface.canvas.height;
      cloneBuffer = document.createElement('canvas');
      cloneBuffer.width = surface.canvas.width;
      cloneBuffer.height = surface.canvas.height;

      const ctx = alphaBuffer.getContext('2d');
      if (!ctx) return;

      engine = new StrokeEngine(ctx, readBrushSettings(context, '#ffffff'));
      engine.begin(toBufferSample(pointer, surface));
      refreshCloneBuffer(context);
      context.invalidateComposite();
    },

    onPointerMove(context: ToolContext, pointer: ToolPointer): void {
      hover = pointer.doc;
      if (!engine || !target) {
        context.requestRender();
        return;
      }

      engine.update(readBrushSettings(context, '#ffffff'));
      for (const sample of pointer.coalesced) engine.extend(toBufferSample(sample, target));

      refreshCloneBuffer(context);
      context.invalidateComposite();
    },

    onPointerUp(context: ToolContext): void {
      engine?.finish();
      endStroke(context);
    },

    onKeyDown(context: ToolContext, event: KeyboardEvent): boolean {
      if (event.key !== '[' && event.key !== ']') return false;
      stepBrushSize(context, event.key === ']' ? 1 : -1);
      context.requestRender();
      return true;
    },

    drawOverlay(ctx: CanvasRenderingContext2D, context: ToolContext): void {
      if (!hover) return;

      const centre = context.viewport.docToScreen(hover.x, hover.y);
      const radius = (context.options.get<number>('size') / 2) * context.viewport.zoom;

      // A preview of the source inside the ring, which is what makes the tool
      // usable: you can see what you are about to lay down.
      const live = offset ?? (sourcePoint
        ? { x: sourcePoint.x - hover.x, y: sourcePoint.y - hover.y }
        : null);

      if (live && radius > 3) {
        const preview = sourceImage ?? previewSource(context);
        if (preview) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(centre.x, centre.y, radius, 0, Math.PI * 2);
          ctx.clip();
          // Same convention as the buffer: the image sits at -offset.
          const origin = context.viewport.docToScreen(-live.x, -live.y);
          ctx.imageSmoothingEnabled = context.viewport.zoom <= 1;
          ctx.drawImage(
            preview, origin.x, origin.y,
            preview.width * context.viewport.zoom, preview.height * context.viewport.zoom,
          );
          ctx.restore();
        }

        // Crosshair at the live source position.
        const from = context.viewport.docToScreen(hover.x + live.x, hover.y + live.y);
        ctx.save();
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.lineWidth = 3;
        for (const pass of [0, 1]) {
          ctx.beginPath();
          ctx.moveTo(from.x - 7, from.y);
          ctx.lineTo(from.x + 7, from.y);
          ctx.moveTo(from.x, from.y - 7);
          ctx.lineTo(from.x, from.y + 7);
          ctx.stroke();
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1;
          void pass;
        }
        ctx.restore();
      }

      drawCursorOutline(ctx, centre, radius, 'round');
    },

    deactivate(context: ToolContext): void {
      hover = null;
      engine = null;
      target = null;
      context.setLiveStroke(null);
    },
  };

  /** The source image outside a stroke, for the hover preview. */
  function previewSource(context: ToolContext): HTMLCanvasElement | null {
    return captureSource(context);
  }
}
