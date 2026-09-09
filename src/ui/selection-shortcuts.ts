import type { ColourState } from '../core/colour-state';
import type { PixelDocument } from '../core/document';
import type { History } from '../core/history';
import {
  deleteSelectedPixels,
  deselect,
  fillSelection,
  invertSelection,
  selectAll,
} from '../core/selection-ops';
import { isTextEntry } from './keyboard';

/**
 * Ctrl+A select all, Ctrl+D deselect, Ctrl+Shift+I invert, Delete to clear the
 * selected pixels and Alt+Delete to fill them with the foreground colour.
 */
export function attachSelectionShortcuts(
  doc: PixelDocument,
  history: History,
  colours: ColourState,
  onChanged: () => void,
): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (isTextEntry(event.target)) return;

    const key = event.key.toLowerCase();
    const command = event.ctrlKey || event.metaKey;

    if (command && !event.altKey) {
      if (key === 'a' && !event.shiftKey) selectAll(doc, history);
      else if (key === 'd' && !event.shiftKey) deselect(doc, history);
      else if (key === 'i' && event.shiftKey) invertSelection(doc, history);
      else return;

      event.preventDefault();
      onChanged();
      return;
    }

    if (key === 'delete' || key === 'backspace') {
      // Alt+Delete fills, plain Delete clears.
      const handled = event.altKey
        ? fillSelection(doc, history, colours.foreground, 'Fill with Foreground')
        : deleteSelectedPixels(doc, history);
      if (!handled) return;

      event.preventDefault();
      onChanged();
    }
  };

  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}
