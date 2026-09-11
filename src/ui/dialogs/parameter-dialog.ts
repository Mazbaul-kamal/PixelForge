import { labelledRow, openDialog } from '../dialog';

export type ParameterControl =
  | { kind: 'slider'; id: string; label: string; min: number; max: number; step?: number; unit?: string }
  | { kind: 'number'; id: string; label: string; min: number; max: number; step?: number; unit?: string }
  | { kind: 'select'; id: string; label: string; choices: readonly { value: string; label: string }[] }
  | { kind: 'colour'; id: string; label: string }
  | { kind: 'checkbox'; id: string; label: string };

export interface ParameterValues {
  [key: string]: number | string | boolean | undefined;
}

export interface ParameterDialogOptions {
  readonly title: string;
  readonly controls: readonly ParameterControl[];
  readonly initial: ParameterValues;
  /** Extra content shown above the controls, such as a histogram or a curve. */
  readonly extra?: HTMLElement;
  /** Called whenever a value changes, and when preview is switched on or off. */
  readonly onPreview: (values: ParameterValues, enabled: boolean) => void;
  readonly onCommit: (values: ParameterValues) => void;
  readonly onCancel: () => void;
  /** Shown while a worker run is in flight. */
  readonly onRequestCancelRun?: () => void;
}

/**
 * The dialog every adjustment and filter uses: live preview, a Preview
 * checkbox to compare against the original, Reset, a Cancel that restores
 * exactly, and an OK that produces a single history entry.
 */
export function openParameterDialog(options: ParameterDialogOptions): {
  setBusy: (busy: boolean, label?: string) => void;
} {
  const values: ParameterValues = { ...options.initial };
  let previewOn = true;
  /** One per control, restoring both the value and its input element. */
  const resetters: Array<() => void> = [];

  const body = document.createElement('div');
  body.className = 'pf-dialog-form';
  if (options.extra) body.appendChild(options.extra);

  const notify = (): void => options.onPreview({ ...values }, previewOn);

  for (const control of options.controls) {
    if (control.kind === 'checkbox') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'pf-checkbox';
      input.checked = values[control.id] === true;
      input.addEventListener('change', () => {
        values[control.id] = input.checked;
        notify();
      });
      resetters.push(() => {
        values[control.id] = options.initial[control.id];
        input.checked = options.initial[control.id] === true;
      });
      body.appendChild(labelledRow(control.label, input));
      continue;
    }

    if (control.kind === 'select') {
      const select = document.createElement('select');
      select.className = 'pf-select';
      for (const choice of control.choices) {
        const option = document.createElement('option');
        option.value = choice.value;
        option.textContent = choice.label;
        select.appendChild(option);
      }
      select.value = String(values[control.id] ?? control.choices[0]?.value ?? '');
      select.addEventListener('change', () => {
        values[control.id] = select.value;
        notify();
      });
      resetters.push(() => {
        values[control.id] = options.initial[control.id];
        select.value = String(options.initial[control.id] ?? '');
      });
      body.appendChild(labelledRow(control.label, select));
      continue;
    }

    if (control.kind === 'colour') {
      const input = document.createElement('input');
      input.type = 'color';
      input.className = 'pf-colour';
      input.value = String(values[control.id] ?? '#ffffff');
      input.addEventListener('input', () => {
        values[control.id] = input.value;
        notify();
      });
      resetters.push(() => {
        values[control.id] = options.initial[control.id];
        input.value = String(options.initial[control.id] ?? '#ffffff');
      });
      body.appendChild(labelledRow(control.label, input));
      continue;
    }

    const input = document.createElement('input');
    input.className = control.kind === 'slider' ? 'pf-range' : 'pf-input pf-input--compact';
    input.type = control.kind === 'slider' ? 'range' : 'number';
    input.min = String(control.min);
    input.max = String(control.max);
    input.step = String(control.step ?? 1);
    input.value = String(values[control.id] ?? control.min);

    const readout = document.createElement('span');
    readout.className = 'pf-field-value';
    const paint = (): void => {
      readout.textContent = `${input.value}${control.unit ?? ''}`;
    };
    paint();

    input.addEventListener('input', () => {
      values[control.id] = Number(input.value);
      paint();
      notify();
    });
    resetters.push(() => {
      values[control.id] = options.initial[control.id];
      input.value = String(options.initial[control.id] ?? control.min);
      paint();
    });
    body.appendChild(labelledRow(control.label, input, readout));
  }

  // ---- preview, reset and busy state ----
  const footerExtras = document.createElement('div');
  footerExtras.className = 'pf-dialog-extras';

  const preview = document.createElement('input');
  preview.type = 'checkbox';
  preview.className = 'pf-checkbox';
  preview.checked = true;
  preview.addEventListener('change', () => {
    previewOn = preview.checked;
    notify();
  });

  const previewLabel = document.createElement('label');
  previewLabel.className = 'pf-field-label';
  previewLabel.textContent = 'Preview';

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'pf-button';
  reset.textContent = 'Reset';
  reset.addEventListener('click', () => {
    // Each control restores its own starting value, so the inputs and the
    // values can never drift apart.
    for (const restore of resetters) restore();
    notify();
  });

  const busy = document.createElement('div');
  busy.className = 'pf-dialog-busy';
  busy.hidden = true;

  const busyLabel = document.createElement('span');
  const cancelRun = document.createElement('button');
  cancelRun.type = 'button';
  cancelRun.className = 'pf-button';
  cancelRun.textContent = 'Stop';
  cancelRun.addEventListener('click', () => options.onRequestCancelRun?.());
  busy.append(busyLabel, cancelRun);

  footerExtras.append(previewLabel, preview, reset);
  body.append(footerExtras, busy);

  let committed = false;
  const dialog = openDialog({
    title: options.title,
    body,
    primaryLabel: 'OK',
    onPrimary: () => {
      committed = true;
      options.onCommit({ ...values });
    },
  });
  dialog.addEventListener('close', () => {
    if (!committed) options.onCancel();
  });

  // The first preview is deferred by a microtask rather than run here.
  // Callers write `const dialog = openParameterDialog({ onPreview: () =>
  // dialog.setBusy(...) })`, so calling back synchronously would touch that
  // binding before it exists — and because the throw escaped from inside this
  // function, the assignment never happened and every later handler threw too.
  queueMicrotask(notify);

  return {
    setBusy: (isBusy, label) => {
      busy.hidden = !isBusy;
      busyLabel.textContent = label ?? 'Working…';
    },
  };
}
