import type { PixelDocument } from '../core/document';
import { addGuide, clearGuides, guideAt, moveGuide, removeGuide } from '../core/guides';
import type { GuideSettings } from '../core/guides';
import type { History } from '../core/history';
import type { Viewport } from '../core/viewport';
import type { Rulers } from '../view/rulers';
import type { ViewRenderer } from '../view/renderer';
import { isTextEntry } from './keyboard';

/** Grab radius for picking up a guide, in screen pixels. */
const GRAB_PX = 6;

export interface GuideDeps {
  readonly doc: PixelDocument;
  readonly history: History;
  readonly viewport: Viewport;
  readonly settings: GuideSettings;
  readonly renderer: ViewRenderer;
  readonly rulers: Rulers;
  readonly view: HTMLElement;
  readonly refresh: () => void;
  readonly notify: (message: string, detail?: string) => void;
}

/**
 * Dragging a guide that is already on the canvas.
 *
 * This runs ahead of the tool manager on the capture phase, because a guide
 * has to be grabbable whatever tool is selected — otherwise you would have to
 * switch to Move just to nudge a guide.
 */
export function attachGuideDragging(deps: GuideDeps): () => void {
  const { doc, history, viewport, settings, renderer } = deps;
  let dragging = -1;
  let pointerId = -1;
  /** The guide list as it was when the drag started, for history. */
  let before: typeof doc.guides = [];

  const docPoint = (event: PointerEvent): { x: number; y: number } => {
    const bounds = deps.view.getBoundingClientRect();
    return viewport.screenToDoc(event.clientX - bounds.left, event.clientY - bounds.top);
  };

  const onDown = (event: PointerEvent): void => {
    if (!settings.guides || event.button !== 0) return;
    const point = docPoint(event);
    const index = guideAt(doc, point.x, point.y, GRAB_PX / viewport.zoom);
    if (index < 0) return;

    // Only take the event once we know there is a guide under the pointer.
    event.preventDefault();
    event.stopPropagation();
    dragging = index;
    pointerId = event.pointerId;
    before = [...doc.guides];
    renderer.highlightedGuide = index;
    try {
      deps.view.setPointerCapture(event.pointerId);
    } catch {
      // No active pointer; the listeners still follow the drag.
    }
    renderer.invalidate();
  };

  const onMove = (event: PointerEvent): void => {
    const marker = docPoint(event);
    deps.rulers.setPointer(marker.x, marker.y);

    if (dragging < 0) {
      if (!settings.guides) return;
      const point = docPoint(event);
      const over = guideAt(doc, point.x, point.y, GRAB_PX / viewport.zoom);
      const guide = over >= 0 ? doc.guides[over] : null;
      deps.view.style.cursor = guide ? (guide.axis === 'x' ? 'ew-resize' : 'ns-resize') : '';
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const point = docPoint(event);
    const guide = doc.guides[dragging];
    if (!guide) return;
    // Write straight through so the drag reads live; history records on drop.
    doc.guides = doc.guides.map((existing, i) => (
      i === dragging
        ? { ...existing, position: Math.round(guide.axis === 'x' ? point.x : point.y) }
        : existing
    ));
    renderer.invalidate();
  };

  const onUp = (event: PointerEvent): void => {
    if (dragging < 0 || event.pointerId !== pointerId) return;
    event.preventDefault();
    event.stopPropagation();

    const index = dragging;
    const original = before;
    dragging = -1;
    pointerId = -1;
    before = [];
    renderer.highlightedGuide = -1;
    try {
      deps.view.releasePointerCapture(event.pointerId);
    } catch {
      // Never captured.
    }

    const guide = doc.guides[index];
    if (!guide) return;

    // Dragged off the canvas means delete, which is how every editor does it.
    const limit = guide.axis === 'x' ? doc.width : doc.height;
    const dropped = guide.position < 0 || guide.position > limit
      ? original.filter((_, i) => i !== index)
      : original.map((existing, i) => (i === index ? guide : existing));
    const label = dropped.length < original.length ? 'Delete Guide' : 'Move Guide';

    // The drag wrote straight to the document so it would read live, so put
    // it back before recording — otherwise the transaction sees no change.
    doc.guides = original;
    history.transaction(label, () => {
      doc.guides = dropped;
    });
    deps.refresh();
  };

  const onLeave = (): void => deps.rulers.clearPointer();
  deps.view.addEventListener('pointerleave', onLeave);
  deps.view.addEventListener('pointerdown', onDown, true);
  deps.view.addEventListener('pointermove', onMove, true);
  deps.view.addEventListener('pointerup', onUp, true);

  return () => {
    deps.view.removeEventListener('pointerleave', onLeave);
    deps.view.removeEventListener('pointerdown', onDown, true);
    deps.view.removeEventListener('pointermove', onMove, true);
    deps.view.removeEventListener('pointerup', onUp, true);
  };
}

/** Ctrl+; guides, Ctrl+' grid, Ctrl+R rulers, Ctrl+Shift+; snap. */
export function attachGuideShortcuts(deps: GuideDeps, onToggle: () => void): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (isTextEntry(event.target)) return;

    const { settings } = deps;
    switch (event.key) {
      case ';':
        if (event.shiftKey) settings.snap = !settings.snap;
        else settings.guides = !settings.guides;
        break;
      case "'":
        settings.grid = !settings.grid;
        break;
      case 'r':
      case 'R':
        settings.rulers = !settings.rulers;
        break;
      default:
        return;
    }
    event.preventDefault();
    onToggle();
  };

  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}

export function newGuideAt(deps: GuideDeps, axis: 'x' | 'y', position: number): void {
  if (!addGuide(deps.doc, deps.history, axis, position)) {
    deps.notify('That guide is already there.');
    return;
  }
  deps.refresh();
}

export function clearAllGuides(deps: GuideDeps): void {
  if (!clearGuides(deps.doc, deps.history)) {
    deps.notify('There are no guides to clear.');
    return;
  }
  deps.refresh();
}

export { moveGuide, removeGuide };
