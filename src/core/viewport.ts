import type { Point } from './types';

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 32;

/** Padding kept between the document and the edge of the stage when fitting. */
const FIT_PADDING = 48;

/**
 * Maps document coordinates to the on-screen stage and back.
 * panX/panY are the stage-space CSS pixel position of document point (0, 0).
 * Tools work in document coordinates and convert only at the edges.
 */
export class Viewport {
  zoom = 1;
  panX = 0;
  panY = 0;
  /** Stage size in CSS pixels. */
  viewWidth = 0;
  viewHeight = 0;

  onChange: (() => void) | null = null;

  screenToDoc(screenX: number, screenY: number): Point {
    return { x: (screenX - this.panX) / this.zoom, y: (screenY - this.panY) / this.zoom };
  }

  docToScreen(docX: number, docY: number): Point {
    return { x: docX * this.zoom + this.panX, y: docY * this.zoom + this.panY };
  }

  panBy(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    this.panX += dx;
    this.panY += dy;
    this.emit();
  }

  panTo(x: number, y: number): void {
    if (this.panX === x && this.panY === y) return;
    this.panX = x;
    this.panY = y;
    this.emit();
  }

  /** Sets zoom while holding the document point under (anchorX, anchorY) still. */
  setZoom(zoom: number, anchorX?: number, anchorY?: number): void {
    const next = clampZoom(zoom);
    if (next === this.zoom) return;

    const ax = anchorX ?? this.viewWidth / 2;
    const ay = anchorY ?? this.viewHeight / 2;
    const before = this.screenToDoc(ax, ay);

    this.zoom = next;
    this.panX = ax - before.x * next;
    this.panY = ay - before.y * next;
    this.emit();
  }

  zoomBy(factor: number, anchorX?: number, anchorY?: number): void {
    this.setZoom(this.zoom * factor, anchorX, anchorY);
  }

  /** Steps through a fixed ladder so keyboard zoom lands on predictable stops. */
  zoomStep(direction: 1 | -1, anchorX?: number, anchorY?: number): void {
    this.setZoom(this.zoom * (direction > 0 ? 2 : 0.5), anchorX, anchorY);
  }

  fitToScreen(docWidth: number, docHeight: number): void {
    if (this.viewWidth <= 0 || this.viewHeight <= 0) return;

    const available = {
      width: Math.max(1, this.viewWidth - FIT_PADDING),
      height: Math.max(1, this.viewHeight - FIT_PADDING),
    };
    const zoom = clampZoom(Math.min(available.width / docWidth, available.height / docHeight));

    this.zoom = zoom;
    this.centreDocument(docWidth, docHeight);
    this.emit();
  }

  /** 100% zoom, keeping the document centred in the stage. */
  actualSize(docWidth: number, docHeight: number): void {
    this.zoom = 1;
    this.centreDocument(docWidth, docHeight);
    this.emit();
  }

  centreDocument(docWidth: number, docHeight: number): void {
    this.panX = Math.round((this.viewWidth - docWidth * this.zoom) / 2);
    this.panY = Math.round((this.viewHeight - docHeight * this.zoom) / 2);
  }

  /**
   * Resizes the stage while keeping whatever document point was under the old
   * centre under the new centre, so the image never jumps on a window resize.
   */
  setViewSize(width: number, height: number): void {
    if (width === this.viewWidth && height === this.viewHeight) return;

    const hadSize = this.viewWidth > 0 && this.viewHeight > 0;
    const anchor = hadSize
      ? this.screenToDoc(this.viewWidth / 2, this.viewHeight / 2)
      : null;

    this.viewWidth = width;
    this.viewHeight = height;

    if (anchor) {
      this.panX = width / 2 - anchor.x * this.zoom;
      this.panY = height / 2 - anchor.y * this.zoom;
    }
    this.emit();
  }

  private emit(): void {
    this.onChange?.();
  }
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM);
}
