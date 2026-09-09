import type { ColourState } from '../core/colour-state';
import type { PixelDocument } from '../core/document';
import type { History } from '../core/history';
import type { Layer, Point, SelectionMask } from '../core/types';
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

/** One pointer sample, already converted into document coordinates. */
export interface ToolPointer {
  /** Document coordinates. Tools work in these. */
  readonly doc: Point;
  /** CSS pixels relative to the view canvas. */
  readonly screen: Point;
  /** 0..1. Devices without pressure report 0.5 while pressed. */
  readonly pressure: number;
  readonly tiltX: number;
  readonly tiltY: number;
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
  /** Ask for a repaint of the view. */
  requestRender(): void;
  /** Report that layer pixels or layer properties changed. */
  invalidateComposite(): void;
  /** Temporarily override the tool's cursor, e.g. while dragging. */
  setCursor(cursor: string | null): void;
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
