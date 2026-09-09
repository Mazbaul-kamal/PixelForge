import type { LayersPanel } from './panels/layers-panel';

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['range', 'checkbox', 'radio', 'button', 'color'].includes(target.type);
  }
  return false;
}

/** Photoshop-compatible layer shortcuts. Delete and F2 are handled by the panel. */
export function attachLayerShortcuts(panel: LayersPanel): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (isTextEntry(event.target)) return;

    const key = event.key.toLowerCase();

    if (event.shiftKey) {
      if (key === 'n') panel.createLayer();
      else if (key === 'e') panel.flatten();
      else return;
    } else if (key === 'j') {
      panel.duplicateSelection();
    } else if (key === 'e') {
      panel.mergeActiveDown();
    } else if (key === ']') {
      panel.moveSelection(1);
    } else if (key === '[') {
      panel.moveSelection(-1);
    } else {
      return;
    }

    event.preventDefault();
  };

  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}
