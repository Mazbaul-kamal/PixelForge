import type { PixelDocument } from '../core/document';
import type { Point } from '../core/types';
import type { Viewport } from '../core/viewport';

/** Wheel deltas arrive in pixels, lines or pages depending on the device. */
const LINE_HEIGHT = 16;
const PAGE_HEIGHT = 400;
const WHEEL_ZOOM_SENSITIVITY = 0.0018;

export interface NavigationOptions {
  /** Called with the pointer in document coordinates, or null when it leaves. */
  onPointerPosition?: (point: Point | null) => void;
}

interface ActivePointer {
  id: number;
  x: number;
  y: number;
  type: string;
}

/**
 * Viewport navigation: wheel zoom towards the pointer, shift+wheel and
 * middle-drag pan, touch drag and pinch, and the zoom keyboard shortcuts.
 */
export function attachViewportNavigation(
  surface: HTMLCanvasElement,
  viewport: Viewport,
  doc: PixelDocument,
  options: NavigationOptions = {},
): () => void {
  const pointers = new Map<number, ActivePointer>();
  let panning = false;
  let lastPan: Point = { x: 0, y: 0 };
  let pinchDistance = 0;
  let pinchCentre: Point = { x: 0, y: 0 };

  // The surface rect is cached: reading it inside pointermove while the status
  // bar is being written would force a layout on every move event.
  let rectLeft = 0;
  let rectTop = 0;
  const refreshRect = (): void => {
    const rect = surface.getBoundingClientRect();
    rectLeft = rect.left;
    rectTop = rect.top;
  };
  refreshRect();

  const rectObserver = new ResizeObserver(refreshRect);
  rectObserver.observe(surface);

  const localPoint = (event: PointerEvent | WheelEvent): Point => ({
    x: event.clientX - rectLeft,
    y: event.clientY - rectTop,
  });

  const reportPointer = (point: Point | null): void => {
    options.onPointerPosition?.(point ? viewport.screenToDoc(point.x, point.y) : null);
  };

  const wheelDelta = (event: WheelEvent): Point => {
    const scale =
      event.deltaMode === 1 ? LINE_HEIGHT : event.deltaMode === 2 ? PAGE_HEIGHT : 1;
    return { x: event.deltaX * scale, y: event.deltaY * scale };
  };

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const delta = wheelDelta(event);
    const local = localPoint(event);

    if (event.shiftKey) {
      const amount = delta.x !== 0 ? delta.x : delta.y;
      viewport.panBy(-amount, 0);
    } else {
      viewport.zoomBy(Math.exp(-delta.y * WHEEL_ZOOM_SENSITIVITY), local.x, local.y);
    }
    reportPointer(local);
  };

  const touchPointers = (): ActivePointer[] =>
    [...pointers.values()].filter((pointer) => pointer.type === 'touch');

  const beginPinch = (touches: ActivePointer[]): void => {
    const [a, b] = touches;
    if (!a || !b) return;
    pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
    pinchCentre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  const onPointerDown = (event: PointerEvent): void => {
    refreshRect();
    const local = localPoint(event);
    pointers.set(event.pointerId, {
      id: event.pointerId,
      x: local.x,
      y: local.y,
      type: event.pointerType,
    });

    const touches = touchPointers();
    if (touches.length === 2) {
      panning = false;
      beginPinch(touches);
      return;
    }

    // A single pointer belongs to the active tool; navigation only claims the
    // middle button and two-finger gestures.
    if (event.pointerType === 'touch' || event.button !== 1) return;

    event.preventDefault();
    surface.setPointerCapture(event.pointerId);
    panning = true;
    lastPan = local;
  };

  const onPointerMove = (event: PointerEvent): void => {
    const local = localPoint(event);
    const tracked = pointers.get(event.pointerId);
    if (tracked) {
      tracked.x = local.x;
      tracked.y = local.y;
    }

    const touches = touchPointers();
    if (touches.length === 2) {
      const [a, b] = touches;
      if (a && b) {
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        const centre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (pinchDistance > 0 && distance > 0) {
          viewport.panBy(centre.x - pinchCentre.x, centre.y - pinchCentre.y);
          viewport.zoomBy(distance / pinchDistance, centre.x, centre.y);
        }
        pinchDistance = distance;
        pinchCentre = centre;
      }
      return;
    }

    if (panning) {
      viewport.panBy(local.x - lastPan.x, local.y - lastPan.y);
      lastPan = local;
    }
    reportPointer(local);
  };

  const endPointer = (event: PointerEvent): void => {
    pointers.delete(event.pointerId);
    if (surface.hasPointerCapture(event.pointerId)) {
      surface.releasePointerCapture(event.pointerId);
    }

    const touches = touchPointers();
    if (touches.length === 2) {
      beginPinch(touches);
    } else {
      pinchDistance = 0;
      panning = false;
    }

    if (event.pointerType === 'touch') reportPointer(null);
  };

  const onPointerLeave = (): void => {
    if (!panning) reportPointer(null);
  };

  // Chrome starts autoscroll on a middle mouse press unless this is cancelled.
  const onMouseDown = (event: MouseEvent): void => {
    if (event.button === 1) event.preventDefault();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;

    switch (event.key) {
      case '0':
        viewport.fitToScreen(doc.width, doc.height);
        break;
      case '1':
        viewport.actualSize(doc.width, doc.height);
        break;
      case '=':
      case '+':
        viewport.zoomStep(1);
        break;
      case '-':
      case '_':
        viewport.zoomStep(-1);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  window.addEventListener('scroll', refreshRect, true);
  surface.addEventListener('wheel', onWheel, { passive: false });
  surface.addEventListener('pointerdown', onPointerDown);
  surface.addEventListener('pointermove', onPointerMove);
  surface.addEventListener('pointerup', endPointer);
  surface.addEventListener('pointercancel', endPointer);
  surface.addEventListener('pointerleave', onPointerLeave);
  surface.addEventListener('mousedown', onMouseDown);
  window.addEventListener('keydown', onKeyDown);

  return () => {
    rectObserver.disconnect();
    window.removeEventListener('scroll', refreshRect, true);
    surface.removeEventListener('wheel', onWheel);
    surface.removeEventListener('pointerdown', onPointerDown);
    surface.removeEventListener('pointermove', onPointerMove);
    surface.removeEventListener('pointerup', endPointer);
    surface.removeEventListener('pointercancel', endPointer);
    surface.removeEventListener('pointerleave', onPointerLeave);
    surface.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('keydown', onKeyDown);
  };
}
