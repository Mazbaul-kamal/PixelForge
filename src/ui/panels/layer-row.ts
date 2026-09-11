import type { Layer } from '../../core/types';
import type { ThumbnailCache } from '../thumbnails';
import { STYLE_ORDER } from '../../core/layer-styles';

const EYE_OPEN =
  '<path d="M1 7s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4z"/><circle cx="7" cy="7" r="1.9"/>';
const EYE_CLOSED = '<path d="M1.5 4.2C2.9 6.1 4.8 7.4 7 7.4s4.1-1.3 5.5-3.2"/><path d="M3.3 8.6 2 10.4"/><path d="M10.7 8.6 12 10.4"/><path d="M7 7.4V10"/>';
const LOCK_CLOSED =
  '<rect x="2.5" y="6" width="9" height="6.2" rx="1.2"/><path d="M4.6 6V4.4a2.4 2.4 0 0 1 4.8 0V6"/>';
const LOCK_OPEN =
  '<rect x="2.5" y="6" width="9" height="6.2" rx="1.2"/><path d="M4.6 6V4.4a2.4 2.4 0 0 1 4.8 0"/>';

function icon(paths: string): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 14 14');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = paths;
  return svg;
}

export interface LayerRowCallbacks {
  onToggleVisible: (id: string) => void;
  onToggleLock: (id: string) => void;
  onPick: (id: string, event: MouseEvent) => void;
  onRename: (id: string, name: string) => void;
  onEditStyles: (id: string) => void;
  /** Ctrl or Cmd click on the thumbnail, which loads the layer as a selection. */
  onLoadSelection: (id: string) => void;
  /** Clicking a thumbnail chooses what painting targets. */
  onPickSurface: (id: string, surface: 'layer' | 'mask') => void;
  /** Shift+click a mask disables it, Alt+click views it alone. */
  onMaskModifier: (id: string, modifier: 'toggle' | 'view') => void;
  onToggleMaskLink: (id: string) => void;
  onToggleGroup: (id: string) => void;
}

export interface LayerRowState {
  active: boolean;
  selected: boolean;
  /** Which surface of THIS layer painting targets, when it is active. */
  target: 'layer' | 'mask';
  /** How deep inside groups this layer sits, for the indent. */
  depth: number;
}

/** One row of the layers list. Rebuilt only when the layer list changes. */
export class LayerRow {
  readonly root: HTMLElement;
  readonly id: string;

  private readonly thumbHost: HTMLElement;
  private readonly maskHost: HTMLElement;
  private readonly maskCanvas: HTMLCanvasElement;
  private readonly linkButton: HTMLButtonElement;
  private readonly disclosure: HTMLButtonElement;
  private readonly nameEl: HTMLElement;
  private readonly badge: HTMLElement;
  private readonly effects: HTMLElement;
  private readonly eyeButton: HTMLButtonElement;
  private readonly lockButton: HTMLButtonElement;
  private readonly thumbs: ThumbnailCache;
  private readonly callbacks: LayerRowCallbacks;
  private editor: HTMLInputElement | null = null;

  constructor(layer: Layer, thumbs: ThumbnailCache, callbacks: LayerRowCallbacks) {
    this.id = layer.id;
    this.thumbs = thumbs;
    this.callbacks = callbacks;

    this.root = document.createElement('div');
    this.root.className = 'pf-layer-row';
    this.root.dataset['layerId'] = layer.id;
    this.root.setAttribute('role', 'option');
    this.root.tabIndex = -1;

    this.disclosure = document.createElement('button');
    this.disclosure.type = 'button';
    this.disclosure.className = 'pf-layer-disclosure';
    this.disclosure.addEventListener('click', (event) => {
      event.stopPropagation();
      callbacks.onToggleGroup(this.id);
    });

    this.eyeButton = document.createElement('button');
    this.eyeButton.type = 'button';
    this.eyeButton.className = 'pf-layer-eye';
    this.eyeButton.addEventListener('click', (event) => {
      event.stopPropagation();
      callbacks.onToggleVisible(this.id);
    });

    this.thumbHost = document.createElement('div');
    this.thumbHost.className = 'pf-layer-thumb';
    this.thumbHost.title = 'Ctrl+click to load as a selection';
    this.thumbHost.addEventListener('click', (event) => {
      event.stopPropagation();
      if (event.ctrlKey || event.metaKey) {
        callbacks.onLoadSelection(this.id);
        return;
      }
      callbacks.onPickSurface(this.id, 'layer');
    });

    // ---- mask thumbnail ----
    this.maskHost = document.createElement('div');
    this.maskHost.className = 'pf-layer-thumb pf-layer-mask';
    this.maskHost.title = 'Layer mask. Shift+click to disable, Alt+click to view it alone.';
    this.maskCanvas = document.createElement('canvas');
    this.maskCanvas.className = 'pf-thumb-canvas';
    this.maskCanvas.width = 36;
    this.maskCanvas.height = 36;
    this.maskHost.appendChild(this.maskCanvas);
    this.maskHost.addEventListener('click', (event) => {
      event.stopPropagation();
      if (event.shiftKey) callbacks.onMaskModifier(this.id, 'toggle');
      else if (event.altKey) callbacks.onMaskModifier(this.id, 'view');
      else callbacks.onPickSurface(this.id, 'mask');
    });

    this.linkButton = document.createElement('button');
    this.linkButton.type = 'button';
    this.linkButton.className = 'pf-mask-link';
    this.linkButton.title = 'Link the mask to the layer';
    this.linkButton.textContent = '⛓';
    this.linkButton.addEventListener('click', (event) => {
      event.stopPropagation();
      callbacks.onToggleMaskLink(this.id);
    });

    const meta = document.createElement('div');
    meta.className = 'pf-layer-meta';

    this.nameEl = document.createElement('span');
    this.nameEl.className = 'pf-layer-name';

    this.badge = document.createElement('span');
    this.badge.className = 'pf-layer-badge';

    this.effects = document.createElement('span');
    this.effects.className = 'pf-layer-fx';
    this.effects.title = 'This layer has effects. Double-click to edit them.';
    this.effects.textContent = 'fx';
    this.effects.hidden = true;
    this.effects.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      this.callbacks.onEditStyles(this.id);
    });

    meta.append(this.nameEl, this.badge, this.effects);

    this.lockButton = document.createElement('button');
    this.lockButton.type = 'button';
    this.lockButton.className = 'pf-layer-lock';
    this.lockButton.addEventListener('click', (event) => {
      event.stopPropagation();
      callbacks.onToggleLock(this.id);
    });

    this.root.append(
      this.disclosure, this.eyeButton, this.thumbHost, this.linkButton, this.maskHost,
      meta, this.lockButton,
    );

    this.root.addEventListener('click', (event) => {
      if (this.editor) return;
      callbacks.onPick(this.id, event);
    });
    this.nameEl.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      this.beginRename();
    });

    this.update(layer, { active: false, selected: false, target: 'layer', depth: 0 });
  }

  update(layer: Layer, state: LayerRowState): void {
    const thumb = this.thumbs.canvasFor(layer);
    if (thumb.parentElement !== this.thumbHost) this.thumbHost.replaceChildren(thumb);

    if (!this.editor) this.nameEl.textContent = layer.name;
    this.root.classList.toggle('is-active', state.active);
    this.root.classList.toggle('is-selected', state.selected);
    this.root.classList.toggle('is-hidden', !layer.visible);
    this.root.classList.toggle('is-locked', layer.locked);
    this.root.classList.toggle('is-clipped', layer.clipped === true);
    this.effects.hidden = !layerHasEffects(layer);
    this.effects.classList.toggle('is-off', layer.stylesEnabled === false);
    this.root.style.setProperty('--depth', String(state.depth));

    const isGroup = layer.type === 'group';
    this.disclosure.hidden = !isGroup;
    if (isGroup) {
      this.disclosure.textContent = layer.collapsed === true ? '▸' : '▾';
      this.disclosure.title = layer.collapsed === true ? 'Expand group' : 'Collapse group';
    }

    // ---- mask ----
    const hasMask = layer.mask !== undefined;
    this.maskHost.hidden = !hasMask;
    this.linkButton.hidden = !hasMask;

    if (hasMask && layer.mask) {
      const ctx = this.maskCanvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, this.maskCanvas.width, this.maskCanvas.height);
        const scale = Math.min(
          this.maskCanvas.width / layer.mask.width,
          this.maskCanvas.height / layer.mask.height,
        );
        const w = layer.mask.width * scale;
        const h = layer.mask.height * scale;
        ctx.drawImage(
          layer.mask,
          (this.maskCanvas.width - w) / 2, (this.maskCanvas.height - h) / 2, w, h,
        );

        // A disabled mask is struck through in red.
        if (layer.maskEnabled === false) {
          ctx.strokeStyle = '#e5624c';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(4, 4);
          ctx.lineTo(this.maskCanvas.width - 4, this.maskCanvas.height - 4);
          ctx.moveTo(this.maskCanvas.width - 4, 4);
          ctx.lineTo(4, this.maskCanvas.height - 4);
          ctx.stroke();
        }
      }
      this.linkButton.classList.toggle('is-off', layer.maskLinked === false);
    }

    // The focus ring says which surface painting will land on.
    const targetsMask = state.active && state.target === 'mask' && hasMask;
    this.thumbHost.classList.toggle('is-paint-target', state.active && !targetsMask);
    this.maskHost.classList.toggle('is-paint-target', targetsMask);
    this.root.setAttribute('aria-selected', state.selected ? 'true' : 'false');

    this.eyeButton.replaceChildren(icon(layer.visible ? EYE_OPEN : EYE_CLOSED));
    this.eyeButton.setAttribute('aria-label', layer.visible ? 'Hide layer' : 'Show layer');
    this.eyeButton.title = layer.visible ? 'Hide layer' : 'Show layer';

    this.lockButton.replaceChildren(icon(layer.locked ? LOCK_CLOSED : LOCK_OPEN));
    this.lockButton.classList.toggle('is-on', layer.locked);
    this.lockButton.setAttribute('aria-label', layer.locked ? 'Unlock layer' : 'Lock layer');
    this.lockButton.title = layer.locked ? 'Unlock layer' : 'Lock layer';

    // Only non-raster layers carry a type badge.
    if (layer.type === 'raster') {
      this.badge.hidden = true;
      this.badge.textContent = '';
    } else {
      this.badge.hidden = false;
      this.badge.textContent = layer.type.charAt(0).toUpperCase() + layer.type.slice(1);
    }
  }

  /** Swaps the name for a text field. Enter commits, Escape abandons. */
  beginRename(): void {
    if (this.editor) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'pf-layer-rename';
    input.value = this.nameEl.textContent ?? '';
    this.editor = input;

    let settled = false;
    const settle = (commit: boolean): void => {
      if (settled) return;
      settled = true;
      const value = input.value;
      this.editor = null;
      input.replaceWith(this.nameEl);
      if (commit) this.callbacks.onRename(this.id, value);
    };

    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') settle(true);
      else if (event.key === 'Escape') settle(false);
    });
    input.addEventListener('blur', () => settle(true));
    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('pointerdown', (event) => event.stopPropagation());

    this.nameEl.replaceWith(input);
    input.focus();
    input.select();
  }
}

/** Any effect switched on, whether or not the set as a whole is hidden. */
function layerHasEffects(layer: Layer): boolean {
  return layer.styles !== undefined && STYLE_ORDER.some((key) => layer.styles![key].enabled);
}
