import type { PixelDocument } from '../../core/document';
import type { History, Transaction } from '../../core/history';
import { BLEND_MODES } from '../../core/types';
import type { BlendMode } from '../../core/types';
import { createPanel } from '../panel';

function formatBlendMode(mode: BlendMode): string {
  return mode
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function row(parent: HTMLElement, label: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pf-field';

  const name = document.createElement('label');
  name.className = 'pf-field-label';
  name.textContent = label;

  const control = document.createElement('div');
  control.className = 'pf-field-control';

  wrap.append(name, control);
  parent.appendChild(wrap);
  return control;
}

/**
 * Blend mode and opacity for the active layer.
 *
 * Opacity is the continuous case the history system has to get right: the
 * transaction opens on the first input event and commits once the drag ends,
 * so a slider swept across its range is a single undo entry.
 */
export class LayerProperties {
  readonly root: HTMLElement;
  private readonly doc: PixelDocument;
  private readonly history: History;
  private readonly onChanged: () => void;
  private readonly blendSelect: HTMLSelectElement;
  private readonly opacityRange: HTMLInputElement;
  private readonly opacityValue: HTMLElement;
  private readonly unsubscribe: () => void;
  private opacityTx: Transaction | null = null;

  constructor(doc: PixelDocument, history: History, onChanged: () => void) {
    this.doc = doc;
    this.history = history;
    this.onChanged = onChanged;

    const panel = createPanel('Layer');
    this.root = panel.root;

    this.blendSelect = document.createElement('select');
    this.blendSelect.className = 'pf-select';
    for (const mode of BLEND_MODES) {
      const option = document.createElement('option');
      option.value = mode;
      option.textContent = formatBlendMode(mode);
      this.blendSelect.appendChild(option);
    }
    row(panel.body, 'Blend').appendChild(this.blendSelect);

    this.opacityRange = document.createElement('input');
    this.opacityRange.type = 'range';
    this.opacityRange.min = '0';
    this.opacityRange.max = '100';
    this.opacityRange.step = '1';
    this.opacityRange.className = 'pf-range';

    this.opacityValue = document.createElement('span');
    this.opacityValue.className = 'pf-field-value';

    const opacityControl = row(panel.body, 'Opacity');
    opacityControl.append(this.opacityRange, this.opacityValue);

    this.blendSelect.addEventListener('change', () => this.commitBlendMode());
    this.opacityRange.addEventListener('input', () => this.dragOpacity());
    this.opacityRange.addEventListener('change', () => this.endOpacityDrag());
    this.opacityRange.addEventListener('pointerup', () => this.endOpacityDrag());
    this.opacityRange.addEventListener('blur', () => this.endOpacityDrag());

    this.unsubscribe = history.subscribe(() => this.refresh());
    this.refresh();
  }

  destroy(): void {
    this.unsubscribe();
    this.root.remove();
  }

  /** Pulls control values back from the document, e.g. after an undo. */
  refresh(): void {
    const layer = this.doc.getActiveLayer();
    const enabled = layer !== null;

    this.blendSelect.disabled = !enabled;
    this.opacityRange.disabled = !enabled;

    if (!layer) {
      this.opacityValue.textContent = '—';
      return;
    }

    this.blendSelect.value = layer.blendMode;
    const percent = Math.round(layer.opacity * 100);
    // Leave the slider alone mid-drag so an undo cannot fight the pointer.
    if (!this.opacityTx) this.opacityRange.value = String(percent);
    this.opacityValue.textContent = `${percent}%`;
  }

  private commitBlendMode(): void {
    const layer = this.doc.getActiveLayer();
    if (!layer) return;

    const mode = this.blendSelect.value as BlendMode;
    if (layer.blendMode === mode) return;

    this.history.transaction('Blend Mode', () => {
      layer.blendMode = mode;
    });
    this.onChanged();
  }

  private dragOpacity(): void {
    const layer = this.doc.getActiveLayer();
    if (!layer) return;

    // One transaction for the whole drag, opened on the first input event.
    this.opacityTx ??= this.history.beginStructural('Layer Opacity');

    const percent = Number(this.opacityRange.value);
    layer.opacity = Math.min(Math.max(percent, 0), 100) / 100;
    this.opacityValue.textContent = `${percent}%`;
    this.onChanged();
  }

  private endOpacityDrag(): void {
    if (!this.opacityTx) return;
    const transaction = this.opacityTx;
    this.opacityTx = null;
    transaction.commit();
  }
}
