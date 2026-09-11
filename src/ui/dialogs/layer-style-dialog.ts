import { cloneStyles, defaultStyles, STYLE_NAMES, STYLE_ORDER } from '../../core/layer-styles';
import type { LayerStyles, StyleKey } from '../../core/layer-styles';
import { BLEND_MODES } from '../../core/types';
import type { BlendMode } from '../../core/types';
import { openDialog } from '../dialog';

interface Field {
  label: string;
  min: number;
  max: number;
  step: number;
  /** Shown as a percentage when the underlying value is 0..1. */
  percent?: boolean;
}

type Numeric = 'opacity' | 'angle' | 'distance' | 'spread' | 'size' | 'scale';

const FIELDS: Record<Numeric, Field> = {
  opacity: { label: 'Opacity', min: 0, max: 1, step: 0.01, percent: true },
  angle: { label: 'Angle', min: -180, max: 180, step: 1 },
  distance: { label: 'Distance', min: 0, max: 250, step: 1 },
  spread: { label: 'Spread', min: 0, max: 1, step: 0.01, percent: true },
  size: { label: 'Size', min: 0, max: 250, step: 1 },
  scale: { label: 'Scale', min: 0.1, max: 3, step: 0.05 },
};

const NUMERIC_BY_STYLE: Record<StyleKey, Numeric[]> = {
  dropShadow: ['opacity', 'angle', 'distance', 'spread', 'size'],
  outerGlow: ['opacity', 'spread', 'size'],
  colourOverlay: ['opacity'],
  gradientOverlay: ['opacity', 'angle', 'scale'],
  innerGlow: ['opacity', 'spread', 'size'],
  innerShadow: ['opacity', 'angle', 'distance', 'spread', 'size'],
  stroke: ['opacity', 'size'],
};

function row(label: string, control: HTMLElement): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'pf-style-row';
  const name = document.createElement('label');
  name.className = 'pf-field-label';
  name.textContent = label;
  wrapper.append(name, control);
  return wrapper;
}

export interface LayerStyleDialogOptions {
  readonly styles: LayerStyles | undefined;
  readonly onPreview: (styles: LayerStyles) => void;
  readonly onCommit: (styles: LayerStyles) => void;
  readonly onCancel: () => void;
}

/**
 * The layer effects editor: the list of effects on the left, the settings for
 * the selected one on the right, and the document updating as you drag.
 */
export function openLayerStyleDialog(options: LayerStyleDialogOptions): void {
  const working = options.styles ? cloneStyles(options.styles) : defaultStyles();
  let selected: StyleKey = STYLE_ORDER.find((key) => working[key].enabled) ?? 'dropShadow';
  let committed = false;

  const body = document.createElement('div');
  body.className = 'pf-style-dialog';

  const list = document.createElement('div');
  list.className = 'pf-style-list';
  const settings = document.createElement('div');
  settings.className = 'pf-style-settings';
  body.append(list, settings);

  const preview = (): void => options.onPreview(cloneStyles(working));

  // Built once and then only updated: rebuilding on every toggle would
  // destroy the checkbox the user just clicked, losing focus with it.
  const items = new Map<StyleKey, HTMLElement>();

  const syncList = (): void => {
    for (const [key, item] of items) {
      item.classList.toggle('is-selected', key === selected);
      const box = item.querySelector('input');
      if (box instanceof HTMLInputElement) box.checked = working[key].enabled;
    }
  };

  const buildList = (): void => {
    for (const key of STYLE_ORDER) {
      const item = document.createElement('div');
      item.className = 'pf-style-item';

      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.className = 'pf-checkbox';
      toggle.checked = working[key].enabled;
      toggle.addEventListener('click', (event) => event.stopPropagation());
      toggle.addEventListener('change', () => {
        working[key].enabled = toggle.checked;
        if (toggle.checked) selected = key;
        syncList();
        renderSettings();
        preview();
      });

      const name = document.createElement('span');
      name.textContent = STYLE_NAMES[key];

      item.append(toggle, name);
      item.addEventListener('click', () => {
        selected = key;
        syncList();
        renderSettings();
      });

      items.set(key, item);
      list.appendChild(item);
    }
    syncList();
  };

  const renderSettings = (): void => {
    settings.replaceChildren();
    const style = working[selected] as unknown as Record<string, unknown>;

    const heading = document.createElement('h3');
    heading.className = 'pf-style-heading';
    heading.textContent = STYLE_NAMES[selected];
    settings.appendChild(heading);

    if (!working[selected].enabled) {
      const hint = document.createElement('p');
      hint.className = 'pf-style-hint';
      hint.textContent = 'Tick this effect in the list to switch it on.';
      settings.appendChild(hint);
    }

    const blend = document.createElement('select');
    blend.className = 'pf-select';
    for (const mode of BLEND_MODES) {
      const option = document.createElement('option');
      option.value = mode;
      option.textContent = mode.replace(/(^|-)([a-z])/g, (_, d: string, c: string) => (d ? ' ' : '') + c.toUpperCase());
      blend.appendChild(option);
    }
    blend.value = style.blendMode as string;
    blend.addEventListener('change', () => {
      style.blendMode = blend.value as BlendMode;
      preview();
    });
    settings.appendChild(row('Blend', blend));

    if (typeof style.colour === 'string') {
      const colour = document.createElement('input');
      colour.type = 'color';
      colour.className = 'pf-colour-input';
      colour.value = style.colour;
      colour.addEventListener('input', () => {
        style.colour = colour.value;
        preview();
      });
      settings.appendChild(row('Colour', colour));
    }

    if (selected === 'stroke') {
      const position = document.createElement('select');
      position.className = 'pf-select';
      for (const value of ['outside', 'centre', 'inside']) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value[0]!.toUpperCase() + value.slice(1);
        position.appendChild(option);
      }
      position.value = working.stroke.position;
      position.addEventListener('change', () => {
        working.stroke.position = position.value as 'inside' | 'centre' | 'outside';
        preview();
      });
      settings.appendChild(row('Position', position));
    }

    if (selected === 'gradientOverlay') {
      const reverse = document.createElement('input');
      reverse.type = 'checkbox';
      reverse.className = 'pf-checkbox';
      reverse.checked = working.gradientOverlay.reverse;
      reverse.addEventListener('change', () => {
        working.gradientOverlay.reverse = reverse.checked;
        preview();
      });
      settings.appendChild(row('Reverse', reverse));
    }

    for (const key of NUMERIC_BY_STYLE[selected]) {
      const field = FIELDS[key];
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'pf-slider';
      slider.min = String(field.min);
      slider.max = String(field.max);
      slider.step = String(field.step);
      slider.value = String(style[key]);

      const readout = document.createElement('span');
      readout.className = 'pf-style-value';
      const show = (): void => {
        const value = Number(style[key]);
        readout.textContent = field.percent
          ? `${Math.round(value * 100)}%`
          : String(Math.round(value * 100) / 100);
      };
      show();

      slider.addEventListener('input', () => {
        style[key] = Number(slider.value);
        show();
        preview();
      });

      const holder = document.createElement('div');
      holder.className = 'pf-style-slider';
      holder.append(slider, readout);
      settings.appendChild(row(field.label, holder));
    }
  };

  buildList();
  renderSettings();

  const dialog = openDialog({
    title: 'Layer Style',
    body,
    primaryLabel: 'OK',
    onPrimary: () => {
      committed = true;
      options.onCommit(cloneStyles(working));
    },
  });

  dialog.addEventListener('close', () => {
    if (!committed) options.onCancel();
  });

  preview();
}
