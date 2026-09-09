import { createLayer } from '../core/layer';
import { canEditLayer } from '../core/layer-ops';
import { applyTextToLayer, TextMeasurer, WEB_SAFE_FONTS } from '../core/text-layer';
import type { TextAlign, TextLayerData, TextStyle } from '../core/text-layer';
import type { Layer, Point } from '../core/types';
import type { Tool, ToolContext, ToolPointer } from './types';

const DRAG_THRESHOLD_PX = 6;

export interface TextEditSession {
  readonly layer: Layer;
  /** Called whenever the layer's bitmap has been regenerated. */
  reposition: () => void;
  close: () => void;
}

export interface TextDeps {
  /** Opens the on-canvas editor and returns a handle to it. */
  beginEditing: (
    layer: Layer,
    padding: number,
    onInput: (text: string) => void,
    onFinish: (commit: boolean) => void,
  ) => TextEditSession;
  onChanged: () => void;
}

function paddingFor(style: TextStyle): number {
  return Math.ceil(style.strokeWidth + style.fontSize * 0.35);
}

/**
 * Text tool. A click makes point text that grows freely; a drag makes a
 * paragraph box that wraps. Either way the layer keeps its string and style,
 * and the bitmap is regenerated from them.
 */
export function createTextTool(deps: TextDeps): Tool {
  const measurer = new TextMeasurer();
  let session: TextEditSession | null = null;
  let editingLayer: Layer | null = null;
  let textBefore = '';

  let dragStart: Point | null = null;
  let dragging = false;

  const styleFrom = (context: ToolContext): TextStyle => ({
    fontFamily: context.options.get<string>('fontFamily'),
    fontSize: context.options.get<number>('fontSize'),
    fontWeight: context.options.get<number>('fontWeight'),
    italic: context.options.get<boolean>('italic'),
    letterSpacing: context.options.get<number>('letterSpacing'),
    lineHeight: context.options.get<number>('lineHeight') / 100,
    align: context.options.get<string>('align') as TextAlign,
    colour: context.colours.foreground,
    strokeWidth: context.options.get<number>('strokeWidth'),
    strokeColour: context.options.get<string>('strokeColour'),
  });

  const rerender = (context: ToolContext, layer: Layer, data: TextLayerData): void => {
    applyTextToLayer(layer, data, measurer);
    context.invalidateComposite();
    session?.reposition();
  };

  const finish = (context: ToolContext, commit: boolean): void => {
    const layer = editingLayer;
    const active = session;
    session = null;
    editingLayer = null;
    active?.close();

    if (!layer || !layer.text) {
      context.requestRender();
      return;
    }

    if (!commit) {
      // Escape puts the text back the way it was.
      rerender(context, layer, { ...layer.text, text: textBefore });
      context.invalidateComposite();
      context.requestRender();
      return;
    }

    if (layer.text.text.trim().length === 0) {
      // An empty text layer is not worth keeping.
      context.doc.removeLayer(layer.id);
      context.invalidateComposite();
      deps.onChanged();
      return;
    }

    deps.onChanged();
    context.requestRender();
  };

  const startEditing = (context: ToolContext, layer: Layer): void => {
    if (!layer.text) return;
    editingLayer = layer;
    textBefore = layer.text.text;

    session = deps.beginEditing(
      layer,
      paddingFor(layer.text.style),
      (text) => {
        const data = layer.text;
        if (!data) return;
        rerender(context, layer, { ...data, text });
      },
      (commit) => finish(context, commit),
    );
    context.requestRender();
  };

  /** Topmost text layer whose bitmap covers the point. */
  const textLayerAt = (context: ToolContext, at: Point): Layer | null => {
    for (let i = context.doc.layers.length - 1; i >= 0; i--) {
      const layer = context.doc.layers[i]!;
      if (layer.type !== 'text' || !layer.visible || !layer.text) continue;
      if (
        at.x >= layer.x && at.y >= layer.y &&
        at.x <= layer.x + layer.canvas.width && at.y <= layer.y + layer.canvas.height
      ) {
        return layer;
      }
    }
    return null;
  };

  const createTextLayer = (context: ToolContext, at: Point, box: { w: number; h: number } | null): void => {
    const style = styleFrom(context);
    const data: TextLayerData = {
      text: '',
      style,
      boxWidth: box ? box.w : null,
      boxHeight: box ? box.h : null,
    };

    const layer = createLayer({ name: 'Text', width: 1, height: 1, type: 'text' });
    layer.x = Math.round(at.x - paddingFor(style));
    layer.y = Math.round(at.y - paddingFor(style));

    context.history.transaction('New Text Layer', () => {
      applyTextToLayer(layer, data, measurer);
      layer.x = Math.round(at.x - paddingFor(style));
      layer.y = Math.round(at.y - paddingFor(style));
      context.doc.addLayer(layer);
      context.doc.setActiveLayer(layer.id);
    });

    deps.onChanged();
    startEditing(context, layer);
  };

  return {
    id: 'text',
    name: 'Text',
    shortcut: 'T',
    cursor: 'text',

    options: [
      {
        type: 'select', id: 'fontFamily', label: 'Font', default: WEB_SAFE_FONTS[0]!,
        choices: WEB_SAFE_FONTS.map((family) => ({
          value: family,
          label: family.split(',')[0]!.replace(/"/g, ''),
        })),
      },
      { type: 'number', id: 'fontSize', label: 'Size', min: 1, max: 800, default: 48, unit: 'px' },
      {
        type: 'select', id: 'fontWeight', label: 'Weight', default: '400',
        choices: [
          { value: '300', label: 'Light' }, { value: '400', label: 'Regular' },
          { value: '600', label: 'Semibold' }, { value: '700', label: 'Bold' },
        ],
      },
      { type: 'checkbox', id: 'italic', label: 'Italic', default: false },
      {
        type: 'select', id: 'align', label: 'Align', default: 'left',
        choices: [
          { value: 'left', label: 'Left' }, { value: 'centre', label: 'Centre' },
          { value: 'right', label: 'Right' },
        ],
      },
      { type: 'slider', id: 'lineHeight', label: 'Line height', min: 50, max: 300, default: 125, unit: '%' },
      { type: 'number', id: 'letterSpacing', label: 'Tracking', min: -20, max: 100, default: 0, unit: 'px' },
      { type: 'number', id: 'strokeWidth', label: 'Stroke', min: 0, max: 40, default: 0, unit: 'px' },
      { type: 'colour', id: 'strokeColour', label: 'Stroke colour', default: '#ffffff' },
    ],

    onPointerDown(context: ToolContext, pointer: ToolPointer): void {
      if (session) {
        // Clicking away is handled by the editor itself.
        return;
      }
      const existing = textLayerAt(context, pointer.doc);
      if (existing && canEditLayer(existing)) {
        context.doc.setActiveLayer(existing.id);
        startEditing(context, existing);
        return;
      }
      dragStart = pointer.doc;
      dragging = false;
    },

    onPointerMove(context: ToolContext, pointer: ToolPointer): void {
      if (!dragStart) return;
      if (Math.hypot(pointer.doc.x - dragStart.x, pointer.doc.y - dragStart.y) > DRAG_THRESHOLD_PX) {
        dragging = true;
        context.requestRender();
      }
    },

    onPointerUp(context: ToolContext, pointer: ToolPointer): void {
      const from = dragStart;
      dragStart = null;
      if (!from || session) return;

      if (!dragging) {
        createTextLayer(context, from, null);
        return;
      }

      dragging = false;
      const x = Math.min(from.x, pointer.doc.x);
      const y = Math.min(from.y, pointer.doc.y);
      const w = Math.abs(pointer.doc.x - from.x);
      const h = Math.abs(pointer.doc.y - from.y);
      createTextLayer(context, { x, y }, { w: Math.max(16, w), h: Math.max(16, h) });
    },

    onKeyDown(_context: ToolContext, event: KeyboardEvent): boolean {
      // While editing, the overlay owns the keyboard.
      return session !== null && event.key !== 'Escape';
    },

    drawOverlay(ctx: CanvasRenderingContext2D, context: ToolContext): void {
      const layer = editingLayer ?? context.activeLayer;
      if (!layer || layer.type !== 'text' || !layer.text) return;

      const topLeft = context.viewport.docToScreen(layer.x, layer.y);
      const bottomRight = context.viewport.docToScreen(
        layer.x + layer.canvas.width,
        layer.y + layer.canvas.height,
      );

      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(76, 159, 254, 0.9)';
      ctx.strokeRect(
        Math.round(topLeft.x) + 0.5, Math.round(topLeft.y) + 0.5,
        Math.round(bottomRight.x - topLeft.x), Math.round(bottomRight.y - topLeft.y),
      );

      // Paragraph text that does not fit shows the usual overflow marker.
      const data = layer.text;
      if (data.boxHeight !== null && layer.canvas.height - paddingFor(data.style) * 2 > data.boxHeight) {
        ctx.setLineDash([]);
        ctx.fillStyle = '#e5624c';
        ctx.fillRect(bottomRight.x - 9, bottomRight.y - 9, 8, 8);
        ctx.strokeStyle = '#ffffff';
        ctx.strokeRect(bottomRight.x - 9.5, bottomRight.y - 9.5, 8, 8);
      }
      ctx.restore();
    },

    /** Used by the layers panel to re-enter editing from a thumbnail. */
    onRailDoubleClick(context: ToolContext): void {
      const layer = context.activeLayer;
      if (layer && layer.type === 'text') startEditing(context, layer);
    },

    deactivate(context: ToolContext): void {
      if (session) finish(context, true);
      dragStart = null;
      dragging = false;
    },
  };
}
