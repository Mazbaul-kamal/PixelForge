import type { PixelDocument } from '../core/document';
import type { SelectionMask } from '../core/selection';
import { traceSelectionOutline } from '../core/selection-contour';
import type { Viewport } from '../core/viewport';

/** Screen pixels per dash, and how fast the ants crawl. */
const DASH_LENGTH = 4;
const DASH_SPEED_PX_PER_SEC = 12;

/**
 * Marching ants.
 *
 * The contour is traced once per selection and cached as a Path2D in document
 * coordinates; only the dash offset changes per frame. Re-tracing every frame
 * on a large mask would cost far more than the whole rest of the view.
 */
export class SelectionOverlay {
  private readonly doc: PixelDocument;
  private readonly viewport: Viewport;

  private tracedFor: SelectionMask | null = null;
  private path: Path2D | null = null;
  private offset = 0;
  private lastFrame = 0;

  constructor(doc: PixelDocument, viewport: Viewport) {
    this.doc = doc;
    this.viewport = viewport;
  }

  /** True while there are ants to animate, so the loop knows to keep going. */
  get isAnimating(): boolean {
    return this.doc.selection !== null;
  }

  draw(ctx: CanvasRenderingContext2D): void {
    const selection = this.doc.selection;
    if (!selection) {
      this.tracedFor = null;
      this.path = null;
      return;
    }

    if (this.tracedFor !== selection) {
      this.path = traceSelectionOutline(selection);
      this.tracedFor = selection;
    }
    if (!this.path) return;

    const now = performance.now();
    const elapsed = this.lastFrame === 0 ? 0 : (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    this.offset = (this.offset + elapsed * DASH_SPEED_PX_PER_SEC) % (DASH_LENGTH * 2);

    const { zoom, panX, panY } = this.viewport;

    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(zoom, zoom);
    // Widths and dashes are divided by zoom so they stay constant on screen.
    ctx.lineWidth = 1 / zoom;

    ctx.setLineDash([DASH_LENGTH / zoom, DASH_LENGTH / zoom]);
    ctx.lineDashOffset = this.offset / zoom;
    ctx.strokeStyle = '#000000';
    ctx.stroke(this.path);

    ctx.lineDashOffset = (this.offset + DASH_LENGTH) / zoom;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke(this.path);

    ctx.restore();
  }
}
