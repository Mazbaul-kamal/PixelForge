import type { PixelDocument } from '../core/document';
import type { Viewport } from '../core/viewport';
import { isTextEntry } from './keyboard';

/**
 * Ctrl+0 fit, Ctrl+1 actual size, Ctrl+plus and Ctrl+minus stepped zoom about
 * the centre of the viewport.
 */
export function attachViewShortcuts(viewport: Viewport, doc: PixelDocument): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (isTextEntry(event.target)) return;

    switch (event.key) {
      case '0':
        viewport.fitToScreen(doc.width, doc.height);
        break;
      case '1':
        viewport.actualSize(doc.width, doc.height);
        break;
      case '=':
      case '+':
        viewport.zoomStep(1);
        break;
      case '-':
      case '_':
        viewport.zoomStep(-1);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}
