import type { Point } from '../core/types';

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

/** Document size, zoom percentage and the pointer in document coordinates. */
export class StatusBar {
  private readonly sizeValue: HTMLElement;
  private readonly zoomValue: HTMLElement;
  private readonly pointerValue: HTMLElement;

  constructor(root: HTMLElement) {
    root.replaceChildren();
    this.sizeValue = field(root, 'Size');
    this.zoomValue = field(root, 'Zoom');
    this.pointerValue = field(root, 'Pointer');
    this.setPointer(null);
  }

  setDocumentSize(width: number, height: number): void {
    this.sizeValue.textContent = `${width} × ${height}`;
  }

  setZoom(zoom: number): void {
    const percent = zoom * 100;
    this.zoomValue.textContent = `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;
  }

  setPointer(point: Point | null): void {
    this.pointerValue.textContent = point
      ? `${Math.floor(point.x)}, ${Math.floor(point.y)}`
      : '—, —';
  }
}
