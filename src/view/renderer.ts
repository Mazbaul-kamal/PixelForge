import type { Compositor } from '../core/compositor';
import type { PixelDocument } from '../core/document';
import type { Viewport } from '../core/viewport';
import { CHECKER_CELL_CSS_PX, createCheckerPattern } from './checkerboard';
import { gridLines } from '../core/guides';
import type { GuideSettings } from '../core/guides';

const MAX_DPR = 2;

/**
 * Owns the on-screen canvas. One requestAnimationFrame loop draws it and
 * nothing else in the app is allowed to touch this canvas.
 */
const GRID_MAJOR = 'rgba(120, 160, 220, 0.45)';
const GRID_MINOR = 'rgba(120, 160, 220, 0.20)';
const GUIDE_COLOUR = 'rgba(0, 190, 255, 0.9)';
const GUIDE_ACTIVE = 'rgba(255, 90, 60, 0.95)';

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
  /**
   * Ruler guides and the grid are drawn here rather than through a tool
   * overlay, because the rAF loop owns this canvas and they must show
   * whichever tool is active.
   */
  private guideSettings: GuideSettings | null = null;
  /** Index of the guide being dragged, drawn highlighted. */
  highlightedGuide = -1;
  /**
   * Run after each frame that actually drew. The rulers hang off this rather
   * than off a viewport subscription, because they need to follow pan and zoom
   * and the render loop already knows exactly when those changed.
   */
  afterDraw: (() => void) | null = null;

  private lastTickAt = 0;
  /**
   * Smoothed time between frames that actually drew, and the cost of the draw
   * itself. Only frames that redraw count: an idle loop is not a fast one.
   */
  frameMs = 0;
  drawMs = 0;

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
  setGuideSettings(settings: GuideSettings | null): void {
    this.guideSettings = settings;
    this.needsRedraw = true;
  }

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
    // The canvas box, not the stage: with rulers showing, the canvas is inset
    // and measuring the stage would size it too large by the ruler thickness.
    const width = this.canvas.clientWidth || this.container.clientWidth;
    const height = this.canvas.clientHeight || this.container.clientHeight;
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
    if (!this.needsRedraw) {
      this.lastTickAt = 0;
      return;
    }

    const now = performance.now();
    if (this.lastTickAt > 0) {
      const elapsed = now - this.lastTickAt;
      this.frameMs = this.frameMs > 0 ? this.frameMs * 0.8 + elapsed * 0.2 : elapsed;
    }
    this.lastTickAt = now;

    this.draw();
    this.drawMs = performance.now() - now;
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
      this.compositor.outputCanvas,
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

    this.drawGuides();
    this.drawOverlay();
    this.afterDraw?.();
  }

  /** The grid first, then the guides over it, both clipped to the document. */
  private drawGuides(): void {
    const settings = this.guideSettings;
    if (!settings || (!settings.grid && !settings.guides)) return;

    const { ctx, doc, viewport } = this;
    const dpr = this.dpr;
    const originX = viewport.panX * dpr;
    const originY = viewport.panY * dpr;
    const scale = viewport.zoom * dpr;

    ctx.save();
    ctx.beginPath();
    ctx.rect(originX, originY, doc.width * scale, doc.height * scale);
    ctx.clip();

    // Half-pixel offsets keep a 1px line on the device pixel grid.
    const vertical = (at: number): number => Math.round(originX + at * scale) + 0.5;
    const horizontal = (at: number): number => Math.round(originY + at * scale) + 0.5;
    const bottom = originY + doc.height * scale;
    const right = originX + doc.width * scale;

    if (settings.grid) {
      const columns = gridLines(settings, doc.width);
      const rows = gridLines(settings, doc.height);

      for (const [lines, colour] of [
        [columns.minor, GRID_MINOR], [columns.major, GRID_MAJOR],
      ] as const) {
        ctx.strokeStyle = colour;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const at of lines) {
          const x = vertical(at);
          ctx.moveTo(x, originY);
          ctx.lineTo(x, bottom);
        }
        ctx.stroke();
      }

      for (const [lines, colour] of [
        [rows.minor, GRID_MINOR], [rows.major, GRID_MAJOR],
      ] as const) {
        ctx.strokeStyle = colour;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const at of lines) {
          const y = horizontal(at);
          ctx.moveTo(originX, y);
          ctx.lineTo(right, y);
        }
        ctx.stroke();
      }
    }

    if (settings.guides) {
      for (let i = 0; i < doc.guides.length; i += 1) {
        const guide = doc.guides[i]!;
        ctx.strokeStyle = i === this.highlightedGuide ? GUIDE_ACTIVE : GUIDE_COLOUR;
        ctx.lineWidth = i === this.highlightedGuide ? 2 : 1;
        ctx.beginPath();
        if (guide.axis === 'x') {
          const x = vertical(guide.position);
          ctx.moveTo(x, originY);
          ctx.lineTo(x, bottom);
        } else {
          const y = horizontal(guide.position);
          ctx.moveTo(originX, y);
          ctx.lineTo(right, y);
        }
        ctx.stroke();
      }
    }

    ctx.restore();
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
