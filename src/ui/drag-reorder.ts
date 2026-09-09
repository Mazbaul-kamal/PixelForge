const MOUSE_THRESHOLD_PX = 4;
const TOUCH_HOLD_MS = 350;

export interface DragReorderOptions {
  /** Scroll container that holds the rows. */
  list: HTMLElement;
  /** Absolutely positioned line shown between rows. */
  indicator: HTMLElement;
  /** Resolves the row element a pointer landed on. */
  rowFromTarget: (target: EventTarget | null) => HTMLElement | null;
  /** True for controls inside a row that must not start a drag. */
  isInteractive: (target: EventTarget | null) => boolean;
  /** Rows being dragged, in display order. Return [] to refuse the drag. */
  onDragStart: (rowId: string) => string[];
  /** `displayIndex` is the gap the block was dropped into, counted top-first. */
  onDrop: (ids: readonly string[], displayIndex: number) => void;
  onDragEnd?: () => void;
}

/**
 * Row reordering with Pointer Events, so it works with a mouse and by touch.
 * A mouse drag starts after a few pixels of movement; a touch drag starts on a
 * short hold, which leaves ordinary vertical scrolling alone.
 */
export function attachDragReorder(options: DragReorderOptions): () => void {
  const { list, indicator } = options;

  let pointerId: number | null = null;
  let startY = 0;
  let dragging = false;
  let draggedIds: string[] = [];
  let holdTimer = 0;
  let dropIndex = 0;

  const rows = (): HTMLElement[] =>
    [...list.querySelectorAll<HTMLElement>('[data-layer-id]')].filter(
      (row) => !row.classList.contains('is-dragging'),
    );

  const clearHold = (): void => {
    if (holdTimer !== 0) window.clearTimeout(holdTimer);
    holdTimer = 0;
  };

  /** Finds the gap nearest the pointer, using row midpoints. */
  const computeDropIndex = (clientY: number): number => {
    const visible = rows();
    for (let i = 0; i < visible.length; i++) {
      const rect = visible[i]!.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return visible.length;
  };

  const showIndicator = (index: number): void => {
    const visible = rows();
    const listRect = list.getBoundingClientRect();
    let offset: number;

    if (visible.length === 0) {
      offset = 0;
    } else if (index >= visible.length) {
      const last = visible[visible.length - 1]!.getBoundingClientRect();
      offset = last.bottom - listRect.top;
    } else {
      offset = visible[index]!.getBoundingClientRect().top - listRect.top;
    }

    indicator.style.top = `${offset + list.scrollTop}px`;
    indicator.hidden = false;
  };

  const beginDrag = (row: HTMLElement, event: PointerEvent): void => {
    const id = row.dataset['layerId'];
    if (!id) return;

    draggedIds = options.onDragStart(id);
    if (draggedIds.length === 0) return;

    dragging = true;
    list.classList.add('is-reordering');
    for (const candidate of list.querySelectorAll<HTMLElement>('[data-layer-id]')) {
      const candidateId = candidate.dataset['layerId'];
      if (candidateId && draggedIds.includes(candidateId)) candidate.classList.add('is-dragging');
    }
    row.setPointerCapture(event.pointerId);
    dropIndex = computeDropIndex(event.clientY);
    showIndicator(dropIndex);
  };

  const finish = (commit: boolean): void => {
    clearHold();
    if (dragging && commit) options.onDrop(draggedIds, dropIndex);

    dragging = false;
    pointerId = null;
    draggedIds = [];
    indicator.hidden = true;
    list.classList.remove('is-reordering');
    for (const row of list.querySelectorAll<HTMLElement>('.is-dragging')) {
      row.classList.remove('is-dragging');
    }
    options.onDragEnd?.();
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (pointerId !== null || event.button !== 0) return;
    if (options.isInteractive(event.target)) return;

    const row = options.rowFromTarget(event.target);
    if (!row) return;

    pointerId = event.pointerId;
    startY = event.clientY;

    if (event.pointerType === 'touch') {
      // Hold to drag, so a swipe still scrolls the list.
      holdTimer = window.setTimeout(() => {
        holdTimer = 0;
        if (pointerId === event.pointerId) beginDrag(row, event);
      }, TOUCH_HOLD_MS);
    }
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (pointerId !== event.pointerId) return;

    if (!dragging) {
      const moved = Math.abs(event.clientY - startY);
      if (event.pointerType === 'touch') {
        // Scrolling won: abandon the pending hold.
        if (moved > MOUSE_THRESHOLD_PX) clearHold();
        return;
      }
      if (moved <= MOUSE_THRESHOLD_PX) return;

      const row = options.rowFromTarget(event.target);
      if (!row) return;
      beginDrag(row, event);
      if (!dragging) return;
    }

    event.preventDefault();
    dropIndex = computeDropIndex(event.clientY);
    showIndicator(dropIndex);
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (pointerId !== event.pointerId) return;
    finish(true);
  };

  const onPointerCancel = (event: PointerEvent): void => {
    if (pointerId !== event.pointerId) return;
    finish(false);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && dragging) finish(false);
  };

  list.addEventListener('pointerdown', onPointerDown);
  list.addEventListener('pointermove', onPointerMove);
  list.addEventListener('pointerup', onPointerUp);
  list.addEventListener('pointercancel', onPointerCancel);
  window.addEventListener('keydown', onKeyDown);

  return () => {
    clearHold();
    list.removeEventListener('pointerdown', onPointerDown);
    list.removeEventListener('pointermove', onPointerMove);
    list.removeEventListener('pointerup', onPointerUp);
    list.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('keydown', onKeyDown);
  };
}
