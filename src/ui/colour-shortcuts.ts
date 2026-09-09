import type { ColourState } from '../core/colour-state';
import { isTextEntry } from './keyboard';

/**
 * X swaps foreground and background, D resets to black on white.
 *
 * These live here rather than inside the swatch widget so that the shortcuts
 * are app behaviour, not something that quietly disappears if the widget is
 * not mounted.
 */
export function attachColourShortcuts(colours: ColourState): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (isTextEntry(event.target)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const key = event.key.toLowerCase();
    if (key === 'x') colours.swap();
    else if (key === 'd') colours.reset();
    else return;

    event.preventDefault();
  };

  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}
