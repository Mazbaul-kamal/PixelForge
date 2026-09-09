import type { ExportFormat, ExportOptions } from '../../core/export';
import { labelledRow, openDialog } from '../dialog';

const SCALES = [0.5, 1, 2] as const;

export function openExportDialog(
  documentSize: { width: number; height: number },
  onExport: (options: ExportOptions) => void | Promise<void>,
): void {
  const body = document.createElement('div');
  body.className = 'pf-dialog-form';

  const format = document.createElement('select');
  format.className = 'pf-select';
  for (const [value, label] of [
    ['png', 'PNG  (keeps transparency)'],
    ['jpeg', 'JPEG  (white background)'],
    ['webp', 'WebP'],
  ] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    format.appendChild(option);
  }

  const scale = document.createElement('select');
  scale.className = 'pf-select';
  for (const value of SCALES) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = `${value}×`;
    if (value === 1) option.selected = true;
    scale.appendChild(option);
  }

  const quality = document.createElement('input');
  quality.type = 'range';
  quality.className = 'pf-range';
  quality.min = '10';
  quality.max = '100';
  quality.step = '1';
  quality.value = '92';

  const qualityValue = document.createElement('span');
  qualityValue.className = 'pf-field-value';
  qualityValue.textContent = '92%';

  const qualityRow = labelledRow('Quality', quality, qualityValue);
  const dimensions = document.createElement('p');
  dimensions.className = 'pf-dialog-note';

  const refresh = (): void => {
    const factor = Number(scale.value);
    const lossy = format.value !== 'png';
    qualityRow.hidden = !lossy;
    qualityValue.textContent = `${quality.value}%`;
    dimensions.textContent = `Exports at ${Math.round(documentSize.width * factor)} × ${Math.round(
      documentSize.height * factor,
    )} px.`;
  };

  format.addEventListener('change', refresh);
  scale.addEventListener('change', refresh);
  quality.addEventListener('input', refresh);

  body.append(
    labelledRow('Format', format),
    labelledRow('Size', scale),
    qualityRow,
    dimensions,
  );
  refresh();

  openDialog({
    title: 'Export Image',
    body,
    primaryLabel: 'Export',
    initialFocus: format,
    onPrimary: () =>
      onExport({
        format: format.value as ExportFormat,
        quality: Number(quality.value) / 100,
        scale: Number(scale.value),
      }),
  });
}
