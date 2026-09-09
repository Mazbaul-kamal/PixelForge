import type { BackgroundKind, NewDocumentOptions } from '../../core/document-io';
import { labelledRow, numberInput, openDialog } from '../dialog';

interface Preset {
  readonly label: string;
  readonly width: number;
  readonly height: number;
}

const PRESETS: readonly Preset[] = [
  { label: 'Square 1080', width: 1080, height: 1080 },
  { label: 'HD 1920 × 1080', width: 1920, height: 1080 },
  { label: 'Story 1080 × 1920', width: 1080, height: 1920 },
  // A4 at 300dpi: 8.27in × 11.69in.
  { label: 'A4 at 300 dpi', width: 2480, height: 3508 },
];

export function openNewDocumentDialog(
  current: { width: number; height: number },
  onCreate: (options: NewDocumentOptions) => void,
): void {
  const body = document.createElement('div');
  body.className = 'pf-dialog-form';

  const presetRow = document.createElement('div');
  presetRow.className = 'pf-presets';

  const width = numberInput(current.width);
  const height = numberInput(current.height);

  for (const preset of PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pf-preset';
    button.textContent = preset.label;
    button.addEventListener('click', () => {
      width.value = String(preset.width);
      height.value = String(preset.height);
    });
    presetRow.appendChild(button);
  }

  const backgroundSelect = document.createElement('select');
  backgroundSelect.className = 'pf-select';
  for (const [value, label] of [
    ['white', 'White'],
    ['transparent', 'Transparent'],
    ['custom', 'Custom colour'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    backgroundSelect.appendChild(option);
  }

  const colour = document.createElement('input');
  colour.type = 'color';
  colour.className = 'pf-colour';
  colour.value = '#3b3b3b';
  colour.hidden = true;

  backgroundSelect.addEventListener('change', () => {
    colour.hidden = backgroundSelect.value !== 'custom';
  });

  body.append(
    presetRow,
    labelledRow('Width', width, unit('px')),
    labelledRow('Height', height, unit('px')),
    labelledRow('Background', backgroundSelect, colour),
  );

  openDialog({
    title: 'New Document',
    body,
    primaryLabel: 'Create',
    initialFocus: width,
    onPrimary: () => {
      onCreate({
        width: clamp(Number(width.value), 1, 20000, current.width),
        height: clamp(Number(height.value), 1, 20000, current.height),
        background: backgroundSelect.value as BackgroundKind,
        colour: colour.value,
      });
    },
  });
}

function unit(text: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'pf-unit';
  span.textContent = text;
  return span;
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), min), max);
}
