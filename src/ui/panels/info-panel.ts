import { rgbToHsl } from '../../core/colour-utils';
import type { SampledColour } from '../../tools/eyedropper-tool';
import { createPanel } from '../panel';

/** R, G, B, hex and HSL of whatever the eyedropper is hovering. */
export class InfoPanel {
  readonly root: HTMLElement;
  private readonly swatch: HTMLElement;
  private readonly rgb: HTMLElement;
  private readonly hsl: HTMLElement;
  private readonly hex: HTMLButtonElement;
  private readonly onCopied: (message: string) => void;

  constructor(onCopied: (message: string) => void) {
    this.onCopied = onCopied;

    const panel = createPanel('Info');
    this.root = panel.root;

    this.swatch = document.createElement('span');
    this.swatch.className = 'pf-info-swatch';

    this.hex = document.createElement('button');
    this.hex.type = 'button';
    this.hex.className = 'pf-info-hex';
    this.hex.title = 'Copy the hex value';
    this.hex.addEventListener('click', () => this.copyHex());

    const header = document.createElement('div');
    header.className = 'pf-info-header';
    header.append(this.swatch, this.hex);

    this.rgb = document.createElement('div');
    this.rgb.className = 'pf-info-row';
    this.hsl = document.createElement('div');
    this.hsl.className = 'pf-info-row';

    panel.body.append(header, this.rgb, this.hsl);
    this.show(null);
  }

  show(sample: SampledColour | null): void {
    if (!sample) {
      this.swatch.style.background = 'transparent';
      this.hex.textContent = '—';
      this.rgb.textContent = 'R — G — B —';
      this.hsl.textContent = 'H — S — L —';
      return;
    }

    const { h, s, l } = rgbToHsl(sample);
    this.swatch.style.background = sample.hex;
    this.hex.textContent = sample.hex.toUpperCase();
    this.rgb.textContent = `R ${sample.r}   G ${sample.g}   B ${sample.b}   A ${sample.a}`;
    this.hsl.textContent = `H ${Math.round(h)}°   S ${Math.round(s)}%   L ${Math.round(l)}%`;
  }

  private copyHex(): void {
    const value = this.hex.textContent ?? '';
    if (!value || value === '—') return;

    void navigator.clipboard?.writeText(value).then(
      () => this.onCopied(`Copied ${value}`),
      () => this.onCopied('Could not reach the clipboard.'),
    );
  }
}
