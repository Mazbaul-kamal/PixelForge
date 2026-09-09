import type { ColourState } from '../core/colour-state';

/**
 * Foreground and background swatches. The X and D keyboard shortcuts that go
 * with them live in colour-shortcuts.ts.
 */
export class ColourSwatches {
  readonly root: HTMLElement;
  private readonly colours: ColourState;
  private readonly foreground: HTMLInputElement;
  private readonly background: HTMLInputElement;
  private readonly detachers: Array<() => void> = [];

  constructor(host: HTMLElement, colours: ColourState) {
    this.colours = colours;

    this.root = document.createElement('div');
    this.root.className = 'pf-swatches';

    this.foreground = this.buildSwatch('Foreground colour', 'pf-swatch--fg');
    this.background = this.buildSwatch('Background colour', 'pf-swatch--bg');

    this.foreground.addEventListener('input', () => {
      colours.foreground = this.foreground.value;
    });
    this.background.addEventListener('input', () => {
      colours.background = this.background.value;
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

  private buildSwatch(label: string, modifier: string): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'color';
    input.className = `pf-swatch ${modifier}`;
    input.title = label;
    input.setAttribute('aria-label', label);
    return input;
  }

  private refresh(): void {
    this.foreground.value = this.colours.foreground;
    this.background.value = this.colours.background;
  }
}
