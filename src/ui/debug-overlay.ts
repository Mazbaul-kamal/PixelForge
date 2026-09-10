import type { Compositor } from '../core/compositor';
import type { FilterRunner } from '../core/filter-runner';
import type { PixelDocument } from '../core/document';
import type { ViewRenderer } from '../view/renderer';
import { isTextEntry } from './keyboard';

/** One frame of a 60fps budget, the number every reading is measured against. */
const BUDGET_MS = 16.7;
const REFRESH_MS = 250;

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function row(parent: HTMLElement, label: string): HTMLElement {
  const line = document.createElement('div');
  line.className = 'pf-debug-row';
  const name = document.createElement('span');
  name.textContent = label;
  const value = document.createElement('span');
  line.append(name, value);
  parent.appendChild(line);
  return line;
}

/**
 * A performance readout, so tuning is measured rather than guessed: frame
 * time, recomposite time, dirty tiles, texture memory and layer count, plus
 * which compositing path is actually running.
 *
 * Toggled with Ctrl+Alt+P. It also carries the WebGL switch, because the one
 * moment you want to turn WebGL off is the moment you are looking at these
 * numbers or at a composite that looks wrong.
 */
export function attachDebugOverlay(
  container: HTMLElement,
  doc: PixelDocument,
  compositor: Compositor,
  renderer: ViewRenderer,
  filters: FilterRunner,
): () => void {
  const panel = document.createElement('div');
  panel.className = 'pf-debug';
  panel.hidden = true;

  const title = document.createElement('div');
  title.className = 'pf-debug-title';
  title.textContent = 'Performance';
  panel.appendChild(title);

  const pathRow = row(panel, 'path');
  const frameRow = row(panel, 'frame');
  const drawRow = row(panel, 'draw');
  const composeRow = row(panel, 'recomposite');
  const tilesRow = row(panel, 'dirty tiles');
  const textureRow = row(panel, 'textures');
  const layersRow = row(panel, 'layers');
  const workersRow = row(panel, 'filter workers');

  const toggle = document.createElement('label');
  toggle.className = 'pf-debug-toggle';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  const toggleText = document.createElement('span');
  toggleText.textContent = 'WebGL compositing';
  toggle.append(checkbox, toggleText);
  panel.appendChild(toggle);

  container.appendChild(panel);

  const set = (line: HTMLElement, value: string, over = false): void => {
    const cell = line.lastElementChild;
    if (cell) cell.textContent = value;
    line.classList.toggle('is-over', over);
  };

  let timer = 0;

  const refresh = (): void => {
    const compose = compositor.lastComposeMs;
    const frame = renderer.frameMs;
    const tiles = compositor.tileStats;

    set(pathRow, compositor.activePath === 'webgl' ? 'WebGL2' : 'Canvas 2D');
    set(frameRow, frame > 0 ? `${frame.toFixed(1)} ms · ${Math.round(1000 / frame)} fps` : 'idle',
      frame > BUDGET_MS);
    set(drawRow, `${renderer.drawMs.toFixed(1)} ms`);
    set(composeRow, `${compose.toFixed(1)} ms`, compose > BUDGET_MS);
    set(tilesRow, `${compositor.lastDirtyTiles} / ${tiles.total}`);
    set(textureRow, compositor.activePath === 'webgl' ? megabytes(compositor.textureBytes) : '—');
    set(layersRow, String(doc.layers.length));
    set(workersRow, filters.poolSize > 0 ? String(filters.poolSize) : 'idle');
  };

  const start = (): void => {
    refresh();
    timer = window.setInterval(refresh, REFRESH_MS);
  };

  const stop = (): void => {
    if (timer) window.clearInterval(timer);
    timer = 0;
  };

  const setVisible = (visible: boolean): void => {
    if (visible === !panel.hidden) return;
    panel.hidden = !visible;
    if (visible) {
      const available = compositor.webglAvailable;
      checkbox.checked = available && compositor.webglEnabled;
      checkbox.disabled = !available;
      toggle.classList.toggle('is-disabled', !available);
      toggleText.textContent = available ? 'WebGL compositing' : 'WebGL2 unavailable';
      start();
    } else {
      stop();
    }
  };

  checkbox.addEventListener('change', () => {
    compositor.webglEnabled = checkbox.checked;
    refresh();
  });

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!event.altKey || !(event.ctrlKey || event.metaKey)) return;
    if (isTextEntry(event.target)) return;
    // Alt can rewrite event.key, so match the physical key.
    if (event.code !== 'KeyP') return;
    event.preventDefault();
    setVisible(panel.hidden === true);
  };

  window.addEventListener('keydown', onKeyDown);

  return () => {
    window.removeEventListener('keydown', onKeyDown);
    stop();
    panel.remove();
  };
}
