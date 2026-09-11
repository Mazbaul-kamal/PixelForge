import type { PixelDocument } from '../core/document';
import type { GuideSettings } from '../core/guides';
import type { Viewport } from '../core/viewport';

const THICKNESS = 18;
/** Candidate steps, in document pixels. The first one wide enough wins. */
const STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
/** No tick may be closer than this on screen, or the labels collide. */
const MIN_TICK_PX = 56;

export interface RulerDeps {
  readonly doc: PixelDocument;
  readonly viewport: Viewport;
  /** The view canvas: the element the viewport's screen coordinates are in. */
  readonly view: HTMLElement;
  readonly settings: GuideSettings;
  /** A guide was dragged out of a ruler and dropped at this document position. */
  readonly onCreateGuide: (axis: 'x' | 'y', position: number) => void;
  /** Live feedback while dragging, before the drop is committed. */
  readonly onPreviewGuide: (axis: 'x' | 'y', position: number | null) => void;
}

/**
 * The rulers along the top and left of the stage.
 *
 * They are their own canvases rather than part of the view canvas, because the
 * rAF loop owns that one and the rulers sit outside the document area; keeping
 * them separate means neither has to know about the other's layout.
 */
export class Rulers {
  readonly corner: HTMLElement;
  readonly horizontal: HTMLCanvasElement;
  readonly vertical: HTMLCanvasElement;
  private readonly deps: RulerDeps;
  private readonly host: HTMLElement;
  private dpr = 1;
  private pointer: { x: number; y: number } | null = null;
  private dragging: 'x' | 'y' | null = null;
  /** What the last paint was for, so a frame that changed nothing is free. */
  private painted = '';

  constructor(host: HTMLElement, deps: RulerDeps) {
    this.host = host;
    this.deps = deps;

    this.corner = document.createElement('div');
    this.corner.className = 'pf-ruler-corner';

    this.horizontal = document.createElement('canvas');
    this.horizontal.className = 'pf-ruler pf-ruler--h';
    this.vertical = document.createElement('canvas');
    this.vertical.className = 'pf-ruler pf-ruler--v';

    host.append(this.corner, this.horizontal, this.vertical);

    this.horizontal.addEventListener('pointerdown', (event) => this.beginDrag(event, 'y'));
    this.vertical.addEventListener('pointerdown', (event) => this.beginDrag(event, 'x'));

    this.setVisible(deps.settings.rulers);
  }

  /** A guide dragged from the top ruler is horizontal, and vice versa. */
  private beginDrag(event: PointerEvent, axis: 'x' | 'y'): void {
    if (!this.deps.settings.rulers) return;
    event.preventDefault();
    this.dragging = axis;

    const target = event.currentTarget as HTMLCanvasElement;
    // Capture keeps the drag alive past the ruler's edge, but it is only an
    // improvement: if the pointer cannot be captured the listeners below still
    // see the drag, so a failure here must not abandon it.
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // No active pointer; carry on without capture.
    }

    const move = (moveEvent: PointerEvent): void => {
      this.deps.onPreviewGuide(axis, this.positionFor(axis, moveEvent));
    };

    const finish = (upEvent: PointerEvent): void => {
      try {
        target.releasePointerCapture(upEvent.pointerId);
      } catch {
        // Never captured, so nothing to release.
      }
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', finish);
      target.removeEventListener('pointercancel', finish);
      this.dragging = null;
      this.deps.onPreviewGuide(axis, null);
      this.deps.onCreateGuide(axis, this.positionFor(axis, upEvent));
    };

    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', finish);
    target.addEventListener('pointercancel', finish);
    move(event);
  }

  private positionFor(axis: 'x' | 'y', event: PointerEvent): number {
    const bounds = this.deps.view.getBoundingClientRect();
    const doc = this.deps.viewport.screenToDoc(
      event.clientX - bounds.left,
      event.clientY - bounds.top,
    );
    return axis === 'x' ? doc.x : doc.y;
  }

  setVisible(visible: boolean): void {
    this.painted = '';
    this.corner.hidden = !visible;
    this.horizontal.hidden = !visible;
    this.vertical.hidden = !visible;
    this.host.classList.toggle('has-rulers', visible);
  }

  /** The pointer marker, so the rulers show where the cursor is. */
  setPointer(x: number, y: number): void {
    this.pointer = { x, y };
    this.draw();
  }

  clearPointer(): void {
    this.pointer = null;
    this.draw();
  }

  get thickness(): number {
    return this.deps.settings.rulers ? THICKNESS : 0;
  }

  /** Picks the smallest step whose ticks stay at least MIN_TICK_PX apart. */
  private step(): number {
    const zoom = this.deps.viewport.zoom;
    for (const candidate of STEPS) {
      if (candidate * zoom >= MIN_TICK_PX) return candidate;
    }
    return STEPS[STEPS.length - 1]!;
  }

  draw(force = false): void {
    if (!this.deps.settings.rulers) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    const bounds = this.host.getBoundingClientRect();
    const { viewport } = this.deps;
    const signature = [
      viewport.zoom, viewport.panX, viewport.panY, bounds.width, bounds.height,
      this.pointer ? `${Math.round(this.pointer.x)},${Math.round(this.pointer.y)}` : '-',
      this.dpr,
    ].join('|');
    if (!force && signature === this.painted) return;
    this.painted = signature;

    this.resize(this.horizontal, bounds.width, THICKNESS);
    this.resize(this.vertical, THICKNESS, bounds.height);

    this.paint(this.horizontal, 'x', bounds.width);
    this.paint(this.vertical, 'y', bounds.height);
  }

  private resize(canvas: HTMLCanvasElement, width: number, height: number): void {
    const w = Math.max(1, Math.round(width * this.dpr));
    const h = Math.max(1, Math.round(height * this.dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  private paint(canvas: HTMLCanvasElement, axis: 'x' | 'y', extent: number): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { viewport, doc } = this.deps;
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const style = getComputedStyle(canvas);
    ctx.fillStyle = style.backgroundColor || '#1f1f1f';
    ctx.fillRect(0, 0, extent, THICKNESS);

    const origin = axis === 'x' ? viewport.panX : viewport.panY;
    const limit = axis === 'x' ? doc.width : doc.height;
    const zoom = viewport.zoom;
    const step = this.step();

    // Shade the span the document occupies, so its extent is readable.
    ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
    if (axis === 'x') ctx.fillRect(origin, 0, limit * zoom, THICKNESS);
    else ctx.fillRect(0, origin, THICKNESS, limit * zoom);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.fillStyle = 'rgba(220, 220, 220, 0.85)';
    ctx.font = '9px var(--pf-font-mono, monospace)';
    ctx.lineWidth = 1;

    const first = Math.floor((-origin / zoom) / step) * step;
    const last = (extent - origin) / zoom;

    ctx.beginPath();
    for (let at = first; at <= last; at += step) {
      const screen = Math.round(origin + at * zoom) + 0.5;
      if (screen < -20 || screen > extent + 20) continue;

      // Minor ticks between the labelled ones.
      for (let sub = 1; sub < 5; sub += 1) {
        const minor = Math.round(origin + (at + (step * sub) / 5) * zoom) + 0.5;
        if (axis === 'x') {
          ctx.moveTo(minor, THICKNESS - 4);
          ctx.lineTo(minor, THICKNESS);
        } else {
          ctx.moveTo(THICKNESS - 4, minor);
          ctx.lineTo(THICKNESS, minor);
        }
      }

      if (axis === 'x') {
        ctx.moveTo(screen, 2);
        ctx.lineTo(screen, THICKNESS);
      } else {
        ctx.moveTo(2, screen);
        ctx.lineTo(THICKNESS, screen);
      }
    }
    ctx.stroke();

    for (let at = first; at <= last; at += step) {
      const screen = origin + at * zoom;
      if (screen < -20 || screen > extent + 20) continue;
      const label = String(Math.round(at));
      if (axis === 'x') {
        ctx.fillText(label, screen + 3, 9);
      } else {
        ctx.save();
        ctx.translate(9, screen - 3);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(label, 0, 0);
        ctx.restore();
      }
    }

    if (this.pointer) {
      const at = axis === 'x' ? this.pointer.x : this.pointer.y;
      const screen = Math.round(origin + at * zoom) + 0.5;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.beginPath();
      if (axis === 'x') {
        ctx.moveTo(screen, 0);
        ctx.lineTo(screen, THICKNESS);
      } else {
        ctx.moveTo(0, screen);
        ctx.lineTo(THICKNESS, screen);
      }
      ctx.stroke();
    }
  }

  get isDragging(): boolean {
    return this.dragging !== null;
  }

  destroy(): void {
    this.corner.remove();
    this.horizontal.remove();
    this.vertical.remove();
  }
}
