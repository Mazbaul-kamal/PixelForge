import type { ColourState } from '../core/colour-state';
import type { PixelDocument } from '../core/document';
import type { History } from '../core/history';
import type { Viewport } from '../core/viewport';
import { isTextEntry } from '../ui/keyboard';
import type { LiveStroke } from '../core/compositor';
import type {
  OptionSpec, Tool, ToolContext, ToolOptions, ToolPointer, ToolSample,
} from './types';

export interface ToolManagerDeps {
  surface: HTMLCanvasElement;
  doc: PixelDocument;
  history: History;
  viewport: Viewport;
  colours: ColourState;
  requestRender: () => void;
  invalidateComposite: () => void;
  setLiveStroke: (stroke: LiveStroke | null) => void;
  readSourcePixels: (allLayers: boolean) => ImageData | null;
  drawingTarget: () => 'layer' | 'mask';
}

function defaultsOf(specs: readonly OptionSpec[]): Map<string, unknown> {
  const values = new Map<string, unknown>();
  for (const spec of specs) {
    if (spec.type !== 'button') values.set(spec.id, spec.default);
  }
  return values;
}

/**
 * Owns the tool registry, routes pointer and keyboard input to the active
 * tool, and holds each tool's option values.
 *
 * Adding a tool is one file plus one register() call: the rail and the options
 * bar both build themselves from what is registered.
 */
export class ToolManager {
  private readonly deps: ToolManagerDeps;
  private readonly tools = new Map<string, Tool>();
  private readonly order: string[] = [];
  private readonly optionValues = new Map<string, Map<string, unknown>>();
  private readonly optionListeners = new Set<() => void>();
  private readonly changeListeners = new Set<() => void>();
  /** Key held down (lower case) mapped to the tool it temporarily selects. */
  private readonly overrides = new Map<string, string>();

  private active: Tool | null = null;
  private overriddenFrom: string | null = null;
  private overrideKey: string | null = null;

  private capturedPointerId: number | null = null;
  private activePointers = 0;
  private cursorOverride: string | null = null;
  private readonly detachers: Array<() => void> = [];

  readonly context: ToolContext;

  constructor(deps: ToolManagerDeps) {
    this.deps = deps;

    const options: ToolOptions = {
      get: <T,>(id: string): T => this.currentValues().get(id) as T,
      set: (id: string, value: unknown): void => {
        this.currentValues().set(id, value);
        for (const listener of this.optionListeners) listener();
      },
      subscribe: (listener: () => void): (() => void) => {
        this.optionListeners.add(listener);
        return () => this.optionListeners.delete(listener);
      },
    };

    this.context = {
      doc: deps.doc,
      history: deps.history,
      viewport: deps.viewport,
      colours: deps.colours,
      options,
      get activeLayer() {
        return deps.doc.getActiveLayer();
      },
      get selection() {
        return deps.doc.selection;
      },
      get drawingTarget() {
        return deps.drawingTarget();
      },
      requestRender: deps.requestRender,
      invalidateComposite: deps.invalidateComposite,
      setLiveStroke: deps.setLiveStroke,
      readSourcePixels: deps.readSourcePixels,
      setCursor: (cursor) => {
        this.cursorOverride = cursor;
        this.applyCursor();
      },
    };

    this.attachPointer();
    this.attachKeyboard();
  }

  destroy(): void {
    for (const detach of this.detachers) detach();
  }

  register(tool: Tool): void {
    this.tools.set(tool.id, tool);
    this.order.push(tool.id);
    this.optionValues.set(tool.id, defaultsOf(tool.options));
    if (!this.active) this.setActiveTool(tool.id);
    this.notifyChanged();
  }

  /** Registers a key that selects `toolId` only while it is held. */
  registerTemporaryOverride(key: string, toolId: string): void {
    this.overrides.set(key.toLowerCase(), toolId);
  }

  get activeTool(): Tool | null {
    return this.active;
  }

  get registered(): readonly Tool[] {
    return this.order.map((id) => this.tools.get(id)!).filter(Boolean);
  }

  /** True while a temporary override such as Space is being held. */
  get isOverridden(): boolean {
    return this.overriddenFrom !== null;
  }

  subscribe(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  setActiveTool(id: string): boolean {
    const tool = this.tools.get(id);
    if (!tool || tool === this.active) return false;

    this.active?.deactivate?.(this.context);
    this.active = tool;
    this.cursorOverride = null;
    tool.activate?.(this.context);

    this.applyCursor();
    this.notifyChanged();
    this.deps.requestRender();
    return true;
  }

  /** Called by the render loop, last, with the canvas in CSS pixel space. */
  drawOverlay(ctx: CanvasRenderingContext2D): void {
    this.active?.drawOverlay?.(ctx, this.context);
  }

  private currentValues(): Map<string, unknown> {
    if (!this.active) return new Map();
    let values = this.optionValues.get(this.active.id);
    if (!values) {
      values = defaultsOf(this.active.options);
      this.optionValues.set(this.active.id, values);
    }
    return values;
  }

  private notifyChanged(): void {
    for (const listener of this.changeListeners) listener();
  }

  private applyCursor(): void {
    this.deps.surface.style.cursor = this.cursorOverride ?? this.active?.cursor ?? 'default';
  }

  private toPointer(event: PointerEvent): ToolPointer {
    const rect = this.deps.surface.getBoundingClientRect();
    const sample = (source: PointerEvent | MouseEvent, pressure: number, tiltX: number, tiltY: number): ToolSample => {
      const screen = { x: source.clientX - rect.left, y: source.clientY - rect.top };
      return {
        doc: this.deps.viewport.screenToDoc(screen.x, screen.y),
        screen,
        pressure,
        tiltX,
        tiltY,
      };
    };

    // Mice report 0 pressure while down; 0.5 is the conventional stand-in.
    const pressureOf = (source: PointerEvent): number =>
      source.pressure > 0 ? source.pressure : source.buttons !== 0 ? 0.5 : 0;

    const self = sample(event, pressureOf(event), event.tiltX, event.tiltY);

    // A high-refresh stylus batches several samples into one event.
    let coalesced: ToolSample[] = [self];
    const raw = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
    if (raw.length > 1) {
      coalesced = raw.map((one) => sample(one, pressureOf(one), one.tiltX, one.tiltY));
    }

    return {
      ...self,
      coalesced,
      button: event.button,
      buttons: event.buttons,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
    };
  }

  private attachPointer(): void {
    const surface = this.deps.surface;

    const onPointerDown = (event: PointerEvent): void => {
      this.activePointers += 1;

      // A second finger means a pinch, which belongs to viewport navigation.
      if (this.activePointers > 1) {
        this.cancelCapture(event);
        return;
      }
      if (event.button !== 0 || !this.active) return;

      this.capturedPointerId = event.pointerId;
      // The pointer can already be gone by the time we get here.
      try {
        surface.setPointerCapture(event.pointerId);
      } catch {
        /* capture is an optimisation, not a requirement */
      }
      this.active.onPointerDown(this.context, this.toPointer(event));
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (!this.active) return;
      if (this.capturedPointerId !== null && event.pointerId !== this.capturedPointerId) return;
      this.active.onPointerMove(this.context, this.toPointer(event));
    };

    const onPointerUp = (event: PointerEvent): void => {
      this.activePointers = Math.max(0, this.activePointers - 1);
      if (this.capturedPointerId !== event.pointerId) return;
      this.releaseCapture(event);
      this.active?.onPointerUp(this.context, this.toPointer(event));
    };

    const onPointerCancel = (event: PointerEvent): void => {
      this.activePointers = Math.max(0, this.activePointers - 1);
      this.cancelCapture(event);
    };

    surface.addEventListener('pointerdown', onPointerDown);
    surface.addEventListener('pointermove', onPointerMove);
    surface.addEventListener('pointerup', onPointerUp);
    surface.addEventListener('pointercancel', onPointerCancel);

    this.detachers.push(() => {
      surface.removeEventListener('pointerdown', onPointerDown);
      surface.removeEventListener('pointermove', onPointerMove);
      surface.removeEventListener('pointerup', onPointerUp);
      surface.removeEventListener('pointercancel', onPointerCancel);
    });
  }

  private releaseCapture(event: PointerEvent): void {
    try {
      if (this.deps.surface.hasPointerCapture(event.pointerId)) {
        this.deps.surface.releasePointerCapture(event.pointerId);
      }
    } catch {
      /* already released */
    }
    this.capturedPointerId = null;
  }

  /** Ends the interaction without letting the tool commit anything further. */
  private cancelCapture(event: PointerEvent): void {
    if (this.capturedPointerId === null) return;
    const pointer = this.toPointer(event);
    this.releaseCapture(event);
    this.active?.onPointerUp(this.context, pointer);
  }

  private attachKeyboard(): void {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isTextEntry(event.target)) return;
      if (this.active?.onKeyDown?.(this.context, event)) {
        event.preventDefault();
        return;
      }
      const key = event.key === ' ' ? 'space' : event.key.toLowerCase();

      // Overrides are checked before the modifier guard, because Alt is itself
      // an override key and would otherwise be filtered out as a modifier.
      const overrideTool = this.overrides.get(key);
      if (overrideTool && !event.ctrlKey && !event.metaKey) {
        // Repeat events fire while the key is held; only the first matters.
        // An interaction in progress is left alone, so Alt cannot break a
        // brush stroke that is halfway done.
        if (
          !event.repeat &&
          this.overriddenFrom === null &&
          this.capturedPointerId === null &&
          this.active
        ) {
          const from = this.active.id;
          if (this.setActiveTool(overrideTool)) {
            this.overriddenFrom = from;
            this.overrideKey = key;
          }
        }
        event.preventDefault();
        return;
      }

      if (event.ctrlKey || event.metaKey || event.altKey) return;

      // Several tools can share a shortcut; pressing it cycles through them.
      const matches = this.registered.filter((tool) => tool.shortcut.toLowerCase() === key);
      if (matches.length > 0) {
        const currentIndex = matches.findIndex((tool) => tool.id === this.active?.id);
        const next = matches[(currentIndex + 1) % matches.length];
        if (next) this.setActiveTool(next.id);
        event.preventDefault();
      }
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      const key = event.key === ' ' ? 'space' : event.key.toLowerCase();
      if (key === this.overrideKey) this.endOverride();
    };

    // Losing focus never delivers keyup, which would strand the override.
    const onBlur = (): void => this.endOverride();

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);

    this.detachers.push(() => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    });
  }

  private endOverride(): void {
    if (this.overriddenFrom === null) return;
    const previous = this.overriddenFrom;
    this.overriddenFrom = null;
    this.overrideKey = null;
    this.setActiveTool(previous);
  }
}
