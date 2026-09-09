import type { History } from '../core/history';
import { isTextEntry } from './keyboard';

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
