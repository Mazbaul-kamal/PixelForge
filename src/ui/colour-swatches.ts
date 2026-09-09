import type { ColourState } from '../core/colour-state';
import { openColourPicker } from './dialogs/colour-picker';

/**
 * Foreground and background swatches. Clicking one opens the full picker; the
 * X and D keyboard shortcuts live in colour-shortcuts.ts.
 */
export class ColourSwatches {
  readonly root: HTMLElement;
  private readonly colours: ColourState;
  private readonly foreground: HTMLButtonElement;
  private readonly background: HTMLButtonElement;
  private readonly detachers: Array<() => void> = [];

  constructor(host: HTMLElement, colours: ColourState) {
    this.colours = colours;

    this.root = document.createElement('div');
    this.root.className = 'pf-swatches';

    this.foreground = this.buildSwatch('Foreground colour', 'pf-swatch--fg');
    this.background = this.buildSwatch('Background colour', 'pf-swatch--bg');

    this.foreground.addEventListener('click', () => {
      openColourPicker(colours.foreground, (hex) => {
        colours.foreground = hex;
      });
    });
    this.background.addEventListener('click', () => {
      openColourPicker(colours.background, (hex) => {
        colours.background = hex;
      });
    });

    const swap = document.createElement('button');
    swap.type = 'button';
    swap.className = 'pf-swatch-action pf-swatch-swap';
    swap.title = 'Swap colours  (X)';
    swap.setAttribute('aria-label', 'Swap foreground and background colours');
    swap.textContent = '⇄';
    swap.addEventListener('click', () => colours.swap());

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'pf-swatch-action pf-swatch-reset';
    reset.title = 'Default colours  (D)';
    reset.setAttribute('aria-label', 'Reset to black and white');
    reset.textContent = '◧';
    reset.addEventListener('click', () => colours.reset());

    this.root.append(this.background, this.foreground, swap, reset);
    host.appendChild(this.root);

    this.detachers.push(colours.subscribe(() => this.refresh()));
    this.refresh();
  }

  destroy(): void {
    for (const detach of this.detachers) detach();
    this.root.remove();
  }

  private buildSwatch(label: string, modifier: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `pf-swatch ${modifier}`;
    button.title = label;
    button.setAttribute('aria-label', label);
    return button;
  }

  private refresh(): void {
    this.foreground.style.background = this.colours.foreground;
    this.background.style.background = this.colours.background;
  }
}
