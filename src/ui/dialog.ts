export interface DialogOptions {
  title: string;
  body: HTMLElement;
  primaryLabel: string;
  onPrimary: () => void | Promise<void>;
  cancelLabel?: string;
  /** Focused when the dialog opens. */
  initialFocus?: HTMLElement;
}

/**
 * Built on the native <dialog>, which brings modality, focus containment and
 * Escape-to-close with it rather than reimplementing them.
 */
export function openDialog(options: DialogOptions): HTMLDialogElement {
  const dialog = document.createElement('dialog');
  dialog.className = 'pf-dialog';

  const form = document.createElement('form');
  form.method = 'dialog';

  const heading = document.createElement('h2');
  heading.className = 'pf-dialog-title';
  heading.textContent = options.title;

  const content = document.createElement('div');
  content.className = 'pf-dialog-body';
  content.appendChild(options.body);

  const footer = document.createElement('div');
  footer.className = 'pf-dialog-footer';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'pf-button';
  cancel.textContent = options.cancelLabel ?? 'Cancel';
  cancel.addEventListener('click', () => dialog.close());

  const primary = document.createElement('button');
  primary.type = 'submit';
  primary.className = 'pf-button pf-button--primary';
  primary.textContent = options.primaryLabel;

  footer.append(cancel, primary);
  form.append(heading, content, footer);
  dialog.appendChild(form);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void Promise.resolve(options.onPrimary()).finally(() => dialog.close());
  });

  dialog.addEventListener('close', () => dialog.remove());
  document.body.appendChild(dialog);
  dialog.showModal();
  (options.initialFocus ?? primary).focus();

  return dialog;
}

/** A yes/no question. Resolves false when dismissed with Escape or Cancel. */
export function confirmDialog(
  title: string,
  message: string,
  confirmLabel: string,
  cancelLabel = 'Cancel',
): Promise<boolean> {
  return new Promise((resolve) => {
    const body = document.createElement('p');
    body.className = 'pf-dialog-message';
    body.textContent = message;

    let confirmed = false;
    const dialog = openDialog({
      title,
      body,
      primaryLabel: confirmLabel,
      cancelLabel,
      onPrimary: () => {
        confirmed = true;
      },
    });
    dialog.addEventListener('close', () => resolve(confirmed));
  });
}

/** Small helpers so the dialog bodies stay readable. */
export function labelledRow(label: string, ...controls: HTMLElement[]): HTMLElement {
  const row = document.createElement('div');
  row.className = 'pf-field';

  const name = document.createElement('span');
  name.className = 'pf-field-label';
  name.textContent = label;

  row.append(name, ...controls);
  return row;
}

export function numberInput(value: number, min = 1, max = 20000): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'pf-input';
  input.min = String(min);
  input.max = String(max);
  input.step = '1';
  input.value = String(value);
  return input;
}
