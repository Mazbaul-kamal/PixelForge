import type { History } from '../core/history';

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['range', 'checkbox', 'radio', 'button', 'color'].includes(target.type);
  }
  return false;
}

/** Ctrl+Z undo, Ctrl+Shift+Z or Ctrl+Y redo. Native undo wins inside text fields. */
export function attachHistoryShortcuts(history: History): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (isTextEntry(event.target)) return;

    const key = event.key.toLowerCase();
    if (key === 'z') {
      if (event.shiftKey) history.redo();
      else history.undo();
    } else if (key === 'y') {
      history.redo();
    } else {
      return;
    }
    event.preventDefault();
  };

  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}
