import type { ColourState } from '../core/colour-state';
import type { PixelDocument } from '../core/document';
import type { History } from '../core/history';
import type { LiveStroke } from '../core/compositor';
import type { SelectionMask } from '../core/selection';
import type { Layer, Point, Rect } from '../core/types';
import type { Viewport } from '../core/viewport';

/** A declarative option. The options bar renders itself from these. */
export type OptionSpec =
  | {
      type: 'slider';
      id: string;
      label: string;
      min: number;
      max: number;
      step?: number;
      unit?: string;
      default: number;
    }
  | {
      type: 'number';
      id: string;
      label: string;
      min?: number;
      max?: number;
      step?: number;
      unit?: string;
      default: number;
    }
  | { type: 'colour'; id: string; label: string; default: string }
  | {
      type: 'select';
      id: string;
      label: string;
      choices: readonly { readonly value: string; readonly label: string }[];
      default: string;
    }
  | { type: 'checkbox'; id: string; label: string; default: boolean }
  | {
      type: 'button';
      id: string;
      label: string;
      /** Tooltip, for buttons whose label is a glyph. */
      title?: string;
      run: (context: ToolContext) => void;
    };

/** Current values for the active tool's options. */
export interface ToolOptions {
  get<T>(id: string): T;
  set(id: string, value: unknown): void;
  subscribe(listener: () => void): () => void;
}

/** One position along a pointer's path, in document coordinates. */
export interface ToolSample {
  /** Document coordinates. Tools work in these. */
  readonly doc: Point;
  /** CSS pixels relative to the view canvas. */
  readonly screen: Point;
  /** 0..1. Devices without pressure report 0.5 while pressed. */
  readonly pressure: number;
  readonly tiltX: number;
  readonly tiltY: number;
}

/** One pointer event, already converted into document coordinates. */
export interface ToolPointer extends ToolSample {
  /**
   * Every sample the device actually captured for this event, oldest first,
   * ending with this one. A 240Hz stylus reports several samples per frame,
   * and a stroke engine must consume them all or fast strokes go polygonal.
   */
  readonly coalesced: readonly ToolSample[];
  readonly button: number;
  readonly buttons: number;
  readonly pointerId: number;
  readonly pointerType: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

/** Everything a tool is allowed to reach. */
export interface ToolContext {
  readonly doc: PixelDocument;
  readonly history: History;
  readonly viewport: Viewport;
  readonly colours: ColourState;
  readonly options: ToolOptions;
  readonly activeLayer: Layer | null;
  readonly selection: SelectionMask | null;
  /**
   * Whether painting currently lands on the layer's pixels or on its mask.
   * Tools never branch on this; they ask for a surface and paint into it.
   */
  readonly drawingTarget: 'layer' | 'mask';
  /** Ask for a repaint of the view. */
  requestRender(): void;
  /**
   * Report that layer pixels or properties changed. Passing the affected
   * document rectangle lets the compositor repaint only those tiles.
   */
  invalidateComposite(region?: Rect): void;
  /**
   * Shows an in-progress stroke composited in the right place in the layer
   * stack. Passing null clears it. Used by every tool that paints into a
   * buffer before committing it to the layer.
   */
  setLiveStroke(stroke: LiveStroke | null): void;
  /** Temporarily override the tool's cursor, e.g. while dragging. */
  setCursor(cursor: string | null): void;
  /**
   * Document-sized pixels to sample from: the whole composite, or just the
   * active layer placed at its offset. Used by the wand and the bucket.
   */
  readSourcePixels(allLayers: boolean): ImageData | null;
}

export interface Tool {
  readonly id: string;
  readonly name: string;
  /** Single character, matched case-insensitively. */
  readonly shortcut: string;
  /** CSS cursor used while this tool is active. */
  readonly cursor: string;
  readonly options: readonly OptionSpec[];

  onPointerDown(context: ToolContext, pointer: ToolPointer): void;
  onPointerMove(context: ToolContext, pointer: ToolPointer): void;
  onPointerUp(context: ToolContext, pointer: ToolPointer): void;
  onKeyDown?(context: ToolContext, event: KeyboardEvent): boolean;

  /**
   * Draws on top of the view. This is the ONLY way a tool may put anything on
   * screen; the render loop calls it last, with the canvas in CSS pixel space.
   * Convert document coordinates with context.viewport.docToScreen().
   */
  drawOverlay?(ctx: CanvasRenderingContext2D, context: ToolContext): void;

  activate?(context: ToolContext): void;
  deactivate?(context: ToolContext): void;

  /** Double-clicking this tool's rail button, e.g. Hand fits the document. */
  onRailDoubleClick?(context: ToolContext): void;
}
