import { BLEND_MODES } from '../../core/types';
import type { BlendMode } from '../../core/types';
import { labelledRow, openDialog } from '../dialog';

export interface FillRequest {
  readonly source: 'foreground' | 'background' | 'custom' | 'pattern';
  readonly colour: string;
  readonly patternId: string;
  readonly opacity: number;
  readonly blendMode: BlendMode;
}

/** The classic Fill dialog: what to fill with, how strongly, and how it blends. */
export function openFillDialog(
  patterns: readonly { id: string; name: string }[],
  onFill: (request: FillRequest) => void,
): void {
  const body = document.createElement('div');
  body.className = 'pf-dialog-form';

  const source = document.createElement('select');
  source.className = 'pf-select';
  for (const [value, label] of [
    ['foreground', 'Foreground colour'],
    ['background', 'Background colour'],
    ['custom', 'Custom colour'],
    ['pattern', 'Pattern'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    source.appendChild(option);
  }

  const colour = document.createElement('input');
  colour.type = 'color';
  colour.className = 'pf-colour';
  colour.value = '#808080';

  const pattern = document.createElement('select');
  pattern.className = 'pf-select';
  for (const entry of patterns) {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = entry.name;
    pattern.appendChild(option);
  }

  const opacity = document.createElement('input');
  opacity.type = 'range';
  opacity.className = 'pf-range';
  opacity.min = '0';
  opacity.max = '100';
  opacity.value = '100';

  const opacityValue = document.createElement('span');
  opacityValue.className = 'pf-field-value';
  opacityValue.textContent = '100%';
  opacity.addEventListener('input', () => {
    opacityValue.textContent = `${opacity.value}%`;
  });

  const blend = document.createElement('select');
  blend.className = 'pf-select';
  for (const mode of BLEND_MODES) {
    const option = document.createElement('option');
    option.value = mode;
    option.textContent = mode.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    blend.appendChild(option);
  }

  const colourRow = labelledRow('Colour', colour);
  const patternRow = labelledRow('Pattern', pattern);
  const refresh = (): void => {
    colourRow.hidden = source.value !== 'custom';
    patternRow.hidden = source.value !== 'pattern';
  };
  source.addEventListener('change', refresh);

  body.append(
    labelledRow('Use', source),
    colourRow,
    patternRow,
    labelledRow('Opacity', opacity, opacityValue),
    labelledRow('Mode', blend),
  );
  refresh();

  openDialog({
    title: 'Fill',
    body,
    primaryLabel: 'Fill',
    initialFocus: source,
    onPrimary: () =>
      onFill({
        source: source.value as FillRequest['source'],
        colour: colour.value,
        patternId: pattern.value,
        opacity: Number(opacity.value) / 100,
        blendMode: blend.value as BlendMode,
      }),
  });
}
