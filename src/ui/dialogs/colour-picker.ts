import { hexToRgb, hslToRgb, hsvToRgb, rgbToHex, rgbToHsl, rgbToHsv } from '../../core/colour-utils';
import type { Rgb } from '../../core/colour-utils';
import { openDialog } from '../dialog';

const SQUARE = 200;
const STRIP_WIDTH = 18;

/** Colours previously chosen, newest first, shared across openings. */
const recents: string[] = [];

function rememberColour(hex: string): void {
  const index = recents.indexOf(hex);
  if (index >= 0) recents.splice(index, 1);
  recents.unshift(hex);
  recents.length = Math.min(recents.length, 12);
}

/**
 * Saturation and value square, hue and alpha strips, and text fields that all
 * stay in sync: editing any one of them updates the rest.
 */
export function openColourPicker(
  initial: string,
  onPick: (hex: string, alpha: number) => void,
): void {
  const start = hexToRgb(initial) ?? { r: 0, g: 0, b: 0 };
  let { h, s, v } = rgbToHsv(start);
  let alpha = 1;
  /** Guards the text fields against being rewritten while being typed into. */
  let syncing = false;

  const body = document.createElement('div');
  body.className = 'pf-picker';

  const square = document.createElement('canvas');
  square.width = SQUARE;
  square.height = SQUARE;
  square.className = 'pf-picker-square';

  const hueStrip = document.createElement('canvas');
  hueStrip.width = STRIP_WIDTH;
  hueStrip.height = SQUARE;
  hueStrip.className = 'pf-picker-strip';

  const alphaStrip = document.createElement('canvas');
  alphaStrip.width = STRIP_WIDTH;
  alphaStrip.height = SQUARE;
  alphaStrip.className = 'pf-picker-strip';

  const fields = document.createElement('div');
  fields.className = 'pf-picker-fields';

  const preview = document.createElement('div');
  preview.className = 'pf-picker-preview';

  const hexField = document.createElement('input');
  hexField.type = 'text';
  hexField.className = 'pf-input';

  const makeNumber = (max: number): HTMLInputElement => {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'pf-input pf-input--compact';
    input.min = '0';
    input.max = String(max);
    return input;
  };

  const rField = makeNumber(255);
  const gField = makeNumber(255);
  const bField = makeNumber(255);
  const hField = makeNumber(360);
  const sField = makeNumber(100);
  const lField = makeNumber(100);

  const recentRow = document.createElement('div');
  recentRow.className = 'pf-picker-recents';

  const currentRgb = (): Rgb => hsvToRgb(h, s, v);

  const paintSquare = (): void => {
    const ctx = square.getContext('2d');
    if (!ctx) return;

    const base = hsvToRgb(h, 1, 1);
    ctx.fillStyle = `rgb(${base.r}, ${base.g}, ${base.b})`;
    ctx.fillRect(0, 0, SQUARE, SQUARE);

    const white = ctx.createLinearGradient(0, 0, SQUARE, 0);
    white.addColorStop(0, 'rgba(255, 255, 255, 1)');
    white.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = white;
    ctx.fillRect(0, 0, SQUARE, SQUARE);

    const black = ctx.createLinearGradient(0, 0, 0, SQUARE);
    black.addColorStop(0, 'rgba(0, 0, 0, 0)');
    black.addColorStop(1, 'rgba(0, 0, 0, 1)');
    ctx.fillStyle = black;
    ctx.fillRect(0, 0, SQUARE, SQUARE);

    const x = s * SQUARE;
    const y = (1 - v) * SQUARE;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  };

  const paintHue = (): void => {
    const ctx = hueStrip.getContext('2d');
    if (!ctx) return;
    for (let y = 0; y < SQUARE; y++) {
      const colour = hsvToRgb((y / SQUARE) * 360, 1, 1);
      ctx.fillStyle = `rgb(${colour.r}, ${colour.g}, ${colour.b})`;
      ctx.fillRect(0, y, STRIP_WIDTH, 1);
    }
    const marker = (h / 360) * SQUARE;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, marker - 1, STRIP_WIDTH, 2);
  };

  const paintAlpha = (): void => {
    const ctx = alphaStrip.getContext('2d');
    if (!ctx) return;
    for (let y = 0; y < SQUARE; y += 6) {
      for (let x = 0; x < STRIP_WIDTH; x += 6) {
        ctx.fillStyle = ((x / 6) + (y / 6)) % 2 === 0 ? '#c8c8c8' : '#f0f0f0';
        ctx.fillRect(x, y, 6, 6);
      }
    }
    const colour = currentRgb();
    const ramp = ctx.createLinearGradient(0, 0, 0, SQUARE);
    ramp.addColorStop(0, `rgba(${colour.r}, ${colour.g}, ${colour.b}, 1)`);
    ramp.addColorStop(1, `rgba(${colour.r}, ${colour.g}, ${colour.b}, 0)`);
    ctx.fillStyle = ramp;
    ctx.fillRect(0, 0, STRIP_WIDTH, SQUARE);

    const marker = (1 - alpha) * SQUARE;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, marker - 1, STRIP_WIDTH, 2);
  };

  const syncFields = (): void => {
    if (syncing) return;
    const rgb = currentRgb();
    const hsl = rgbToHsl(rgb);

    hexField.value = rgbToHex(rgb);
    rField.value = String(rgb.r);
    gField.value = String(rgb.g);
    bField.value = String(rgb.b);
    hField.value = String(Math.round(hsl.h));
    sField.value = String(Math.round(hsl.s));
    lField.value = String(Math.round(hsl.l));
    preview.style.background = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
  };

  const refresh = (): void => {
    paintSquare();
    paintHue();
    paintAlpha();
    syncFields();
  };

  const adoptRgb = (rgb: Rgb): void => {
    const hsv = rgbToHsv(rgb);
    h = hsv.h;
    s = hsv.s;
    v = hsv.v;
    refresh();
  };

  /** Drag anywhere on a canvas, including outside it once the drag starts. */
  const track = (canvas: HTMLCanvasElement, update: (x: number, y: number) => void): void => {
    const handle = (event: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      update(
        Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
        Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
      );
      refresh();
    };

    canvas.addEventListener('pointerdown', (event) => {
      canvas.setPointerCapture(event.pointerId);
      handle(event);

      const onMove = (move: PointerEvent): void => handle(move);
      const onUp = (): void => {
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
      };
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp);
    });
  };

  track(square, (x, y) => { s = x; v = 1 - y; });
  track(hueStrip, (_x, y) => { h = y * 360; });
  track(alphaStrip, (_x, y) => { alpha = 1 - y; });

  hexField.addEventListener('input', () => {
    const rgb = hexToRgb(hexField.value);
    if (!rgb) return;
    syncing = true;
    adoptRgb(rgb);
    syncing = false;
    // Everything except the field being typed into is refreshed above.
    preview.style.background = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
  });

  const onRgbInput = (): void => {
    adoptRgb({
      r: Number(rField.value) || 0,
      g: Number(gField.value) || 0,
      b: Number(bField.value) || 0,
    });
  };
  for (const field of [rField, gField, bField]) field.addEventListener('change', onRgbInput);

  const onHslInput = (): void => {
    adoptRgb(hslToRgb({
      h: Number(hField.value) || 0,
      s: Number(sField.value) || 0,
      l: Number(lField.value) || 0,
    }));
  };
  for (const field of [hField, sField, lField]) field.addEventListener('change', onHslInput);

  const labelled = (text: string, ...controls: HTMLElement[]): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'pf-field';
    const name = document.createElement('span');
    name.className = 'pf-field-label';
    name.textContent = text;
    row.append(name, ...controls);
    return row;
  };

  fields.append(
    labelled('Hex', hexField),
    labelled('RGB', rField, gField, bField),
    labelled('HSL', hField, sField, lField),
  );

  for (const entry of recents) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'pf-picker-recent';
    swatch.style.background = entry;
    swatch.title = entry;
    swatch.addEventListener('click', () => {
      const rgb = hexToRgb(entry);
      if (rgb) adoptRgb(rgb);
    });
    recentRow.appendChild(swatch);
  }

  const canvases = document.createElement('div');
  canvases.className = 'pf-picker-canvases';
  canvases.append(square, hueStrip, alphaStrip);

  body.append(canvases, preview, fields, recentRow);
  refresh();

  openDialog({
    title: 'Colour Picker',
    body,
    primaryLabel: 'OK',
    initialFocus: hexField,
    onPrimary: () => {
      const hex = rgbToHex(currentRgb());
      rememberColour(hex);
      onPick(hex, alpha);
    },
  });
}
