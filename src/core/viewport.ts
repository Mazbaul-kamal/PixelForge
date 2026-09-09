import type { Point } from './types';
import { nextZoomStop } from './zoom-ladder';

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 32;

/** Padding kept between the document and the edge of the stage when fitting. */
const FIT_PADDING = 48;

/** The document can always be grabbed back: this much of it stays on screen. */
export const MIN_VISIBLE_PX = 60;

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

  /** Document size, needed to keep part of it on screen while panning. */
  private contentWidth = 0;
  private contentHeight = 0;

  setContentSize(width: number, height: number): void {
    if (width === this.contentWidth && height === this.contentHeight) return;
    this.contentWidth = width;
    this.contentHeight = height;
    if (this.applyPan(this.panX, this.panY)) this.emit();
  }

  screenToDoc(screenX: number, screenY: number): Point {
    return { x: (screenX - this.panX) / this.zoom, y: (screenY - this.panY) / this.zoom };
  }

  docToScreen(docX: number, docY: number): Point {
    return { x: docX * this.zoom + this.panX, y: docY * this.zoom + this.panY };
  }

  panBy(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    if (this.applyPan(this.panX + dx, this.panY + dy)) this.emit();
  }

  panTo(x: number, y: number): void {
    if (this.applyPan(x, y)) this.emit();
  }

  /**
   * Writes a pan position, clamped so the document can never be dragged
   * entirely off screen. Returns true when the position actually moved.
   */
  private applyPan(x: number, y: number): boolean {
    const clamped = this.clampPan(x, y);
    if (clamped.x === this.panX && clamped.y === this.panY) return false;
    this.panX = clamped.x;
    this.panY = clamped.y;
    return true;
  }

  private clampPan(x: number, y: number): Point {
    return {
      x: clampAxis(x, this.contentWidth * this.zoom, this.viewWidth),
      y: clampAxis(y, this.contentHeight * this.zoom, this.viewHeight),
    };
  }

  /** Sets zoom while holding the document point under (anchorX, anchorY) still. */
  setZoom(zoom: number, anchorX?: number, anchorY?: number): void {
    const next = clampZoom(zoom);
    if (next === this.zoom) return;

    const ax = anchorX ?? this.viewWidth / 2;
    const ay = anchorY ?? this.viewHeight / 2;
    const before = this.screenToDoc(ax, ay);

    this.zoom = next;
    this.applyPan(ax - before.x * next, ay - before.y * next);
    this.emit();
  }

  zoomBy(factor: number, anchorX?: number, anchorY?: number): void {
    this.setZoom(this.zoom * factor, anchorX, anchorY);
  }

  /** Steps to the next standard zoom stop, so zooming lands on exact values. */
  zoomStep(direction: 1 | -1, anchorX?: number, anchorY?: number): void {
    this.setZoom(nextZoomStop(this.zoom, direction), anchorX, anchorY);
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

  /** Zooms so the document covers the stage, cropping the longer side. */
  fillScreen(docWidth: number, docHeight: number): void {
    if (this.viewWidth <= 0 || this.viewHeight <= 0) return;

    this.zoom = clampZoom(
      Math.max(this.viewWidth / docWidth, this.viewHeight / docHeight),
    );
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
    this.applyPan(
      Math.round((this.viewWidth - docWidth * this.zoom) / 2),
      Math.round((this.viewHeight - docHeight * this.zoom) / 2),
    );
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
      this.applyPan(width / 2 - anchor.x * this.zoom, height / 2 - anchor.y * this.zoom);
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

/**
 * Keeps `MIN_VISIBLE_PX` of the content on screen along one axis. A document
 * smaller than that on screen has to stay fully visible instead.
 */
function clampAxis(pan: number, contentLength: number, viewLength: number): number {
  if (contentLength <= 0 || viewLength <= 0) return pan;

  const required = Math.min(MIN_VISIBLE_PX, contentLength);
  const min = required - contentLength;
  const max = viewLength - required;

  // Too little room to satisfy both edges: centre instead.
  if (min > max) return (viewLength - contentLength) / 2;
  return Math.min(Math.max(pan, min), max);
}
