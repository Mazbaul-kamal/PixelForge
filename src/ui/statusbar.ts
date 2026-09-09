import type { Point } from '../core/types';
import { formatZoomPercent, parseZoomPercent } from '../core/zoom-ladder';

function field(root: HTMLElement, label: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pf-status-field';

  const name = document.createElement('span');
  name.className = 'pf-status-label';
  name.textContent = label;

  const value = document.createElement('span');
  value.className = 'pf-status-value';

  wrap.append(name, value);
  root.appendChild(wrap);
  return value;
}

export interface StatusBarOptions {
  /** Called when a zoom percentage is typed into the status bar. */
  onZoomEntered?: (zoom: number) => void;
}

/** Document size, an editable zoom percentage, and the pointer position. */
export class StatusBar {
  private readonly sizeValue: HTMLElement;
  private readonly zoomInput: HTMLInputElement;
  private readonly pointerValue: HTMLElement;
  private zoom = 1;

  constructor(root: HTMLElement, options: StatusBarOptions = {}) {
    root.replaceChildren();
    this.sizeValue = field(root, 'Size');

    const zoomWrap = document.createElement('div');
    zoomWrap.className = 'pf-status-field';

    const zoomLabel = document.createElement('label');
    zoomLabel.className = 'pf-status-label';
    zoomLabel.textContent = 'Zoom';
    zoomLabel.htmlFor = 'pf-zoom-input';

    this.zoomInput = document.createElement('input');
    this.zoomInput.type = 'text';
    this.zoomInput.id = 'pf-zoom-input';
    this.zoomInput.className = 'pf-status-zoom';
    this.zoomInput.inputMode = 'decimal';
    this.zoomInput.setAttribute('aria-label', 'Zoom percentage');

    const percent = document.createElement('span');
    percent.className = 'pf-status-label';
    percent.textContent = '%';

    zoomWrap.append(zoomLabel, this.zoomInput, percent);
    root.appendChild(zoomWrap);

    this.pointerValue = field(root, 'Pointer');

    const commit = (): void => {
      const parsed = parseZoomPercent(this.zoomInput.value);
      if (parsed === null) {
        // Unreadable input just snaps back to the real zoom.
        this.paintZoom();
        return;
      }
      options.onZoomEntered?.(parsed);
      this.paintZoom();
    };

    this.zoomInput.addEventListener('change', commit);
    this.zoomInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        commit();
        this.zoomInput.blur();
      } else if (event.key === 'Escape') {
        this.paintZoom();
        this.zoomInput.blur();
      }
      event.stopPropagation();
    });
    this.zoomInput.addEventListener('focus', () => this.zoomInput.select());

    this.setZoom(1);
    this.setPointer(null);
  }

  setDocumentSize(width: number, height: number): void {
    this.sizeValue.textContent = `${width} × ${height}`;
  }

  setZoom(zoom: number): void {
    this.zoom = zoom;
    // Never fight the user mid-edit.
    if (document.activeElement === this.zoomInput) return;
    this.paintZoom();
  }

  setPointer(point: Point | null): void {
    this.pointerValue.textContent = point
      ? `${Math.floor(point.x)}, ${Math.floor(point.y)}`
      : '—, —';
  }

  private paintZoom(): void {
    this.zoomInput.value = formatZoomPercent(this.zoom);
  }
}
