import type { Compositor } from '../core/compositor';
import type { PixelDocument } from '../core/document';
import type { Viewport } from '../core/viewport';
import { CHECKER_CELL_CSS_PX, createCheckerPattern } from './checkerboard';

const MAX_DPR = 2;

/**
 * Owns the on-screen canvas. One requestAnimationFrame loop draws it and
 * nothing else in the app is allowed to touch this canvas.
 */
export class ViewRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly doc: PixelDocument;
  private readonly compositor: Compositor;
  private readonly viewport: Viewport;
  private readonly container: HTMLElement;
  private readonly resizeObserver: ResizeObserver;

  private dpr = 1;
  private checker: CanvasPattern | null = null;
  private checkerDpr = 0;
  private needsRedraw = true;
  private frame = 0;
  private overlay: ((ctx: CanvasRenderingContext2D) => void) | null = null;

  private checkerA = '#cfcfcf';
  private checkerB = '#f2f2f2';
  private docBorder = 'rgba(0, 0, 0, 0.55)';

  constructor(
    container: HTMLElement,
    doc: PixelDocument,
    compositor: Compositor,
    viewport: Viewport,
  ) {
    this.container = container;
    this.doc = doc;
    this.compositor = compositor;
    this.viewport = viewport;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pf-view';
    container.appendChild(this.canvas);

    const ctx = this.canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('Could not acquire a 2D context for the view.');
    this.ctx = ctx;

    this.readThemeColours();

    this.resizeObserver = new ResizeObserver(() => this.syncSize());
    this.resizeObserver.observe(container);
    this.syncSize();
  }

  /** Marks the view as needing a redraw on the next frame. */
  invalidate = (): void => {
    this.needsRedraw = true;
  };

  /**
   * Registers the painter drawn last, on top of everything. Tools reach the
   * screen only through here; nothing else may touch the view canvas.
   */
  setOverlayPainter(painter: ((ctx: CanvasRenderingContext2D) => void) | null): void {
    this.overlay = painter;
    this.needsRedraw = true;
  }

  start(): void {
    if (this.frame !== 0) return;
    const loop = (): void => {
      this.frame = requestAnimationFrame(loop);
      this.tick();
    };
    this.frame = requestAnimationFrame(loop);
  }

  stop(): void {
    if (this.frame !== 0) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  destroy(): void {
    this.stop();
    this.resizeObserver.disconnect();
    this.canvas.remove();
  }

  /** Reads sizing from the container and keeps the backing store at DPR. */
  syncSize(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width <= 0 || height <= 0) return;

    this.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const backingWidth = Math.max(1, Math.round(width * this.dpr));
    const backingHeight = Math.max(1, Math.round(height * this.dpr));

    if (this.canvas.width !== backingWidth || this.canvas.height !== backingHeight) {
      this.canvas.width = backingWidth;
      this.canvas.height = backingHeight;
    }

    this.viewport.setViewSize(width, height);
    this.needsRedraw = true;
  }

  private tick(): void {
    if (Math.min(window.devicePixelRatio || 1, MAX_DPR) !== this.dpr) this.syncSize();
    if (this.compositor.composeIfDirty()) this.needsRedraw = true;
    if (!this.needsRedraw) return;

    this.draw();
    this.needsRedraw = false;
  }

  private draw(): void {
    const { ctx, canvas, doc, viewport } = this;
    const dpr = this.dpr;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Document rect in device pixels.
    const x = viewport.panX * dpr;
    const y = viewport.panY * dpr;
    const width = doc.width * viewport.zoom * dpr;
    const height = doc.height * viewport.zoom * dpr;
    if (width <= 0 || height <= 0) return;

    this.ensureChecker();

    // Checkerboard, anchored to the document's top-left so it can never drift
    // out of alignment with the document rect while panning.
    if (this.checker) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, width, height);
      ctx.clip();
      ctx.translate(Math.round(x), Math.round(y));
      ctx.fillStyle = this.checker;
      ctx.fillRect(-2, -2, width + 4, height + 4);
      ctx.restore();
    }

    ctx.imageSmoothingEnabled = viewport.zoom <= 1;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      this.compositor.canvas,
      0,
      0,
      doc.width,
      doc.height,
      x,
      y,
      width,
      height,
    );
    ctx.imageSmoothingEnabled = true;

    // 1px document border, snapped to the device pixel grid so it stays crisp.
    const left = Math.round(x) - 0.5;
    const top = Math.round(y) - 0.5;
    const right = Math.round(x + width) + 0.5;
    const bottom = Math.round(y + height) + 0.5;
    ctx.lineWidth = 1;
    ctx.strokeStyle = this.docBorder;
    ctx.strokeRect(left, top, right - left, bottom - top);

    this.drawOverlay();
  }

  /** Tool overlays run last, in CSS pixel space so 1px strokes stay 1px. */
  private drawOverlay(): void {
    if (!this.overlay) return;

    const { ctx } = this;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    try {
      this.overlay(ctx);
    } finally {
      ctx.restore();
    }
  }

  private ensureChecker(): void {
    if (this.checker && this.checkerDpr === this.dpr) return;
    this.checker = createCheckerPattern(
      this.ctx,
      CHECKER_CELL_CSS_PX * this.dpr,
      this.checkerA,
      this.checkerB,
    );
    this.checkerDpr = this.dpr;
  }

  private readThemeColours(): void {
    const styles = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string): string =>
      styles.getPropertyValue(name).trim() || fallback;

    this.checkerA = read('--pf-checker-a', this.checkerA);
    this.checkerB = read('--pf-checker-b', this.checkerB);
    this.docBorder = read('--pf-doc-border', this.docBorder);
  }
}
