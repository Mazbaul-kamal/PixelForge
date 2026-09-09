import { buildGradientLut, cloneGradient } from '../../core/gradient';
import type { GradientDefinition } from '../../core/gradient';
import { openDialog } from '../dialog';

/** Dragging a stop this far off the strip removes it. */
const REMOVE_DISTANCE_PX = 30;

interface Handle {
  readonly element: HTMLElement;
  readonly kind: 'colour' | 'opacity' | 'midpoint';
  readonly index: number;
}

/**
 * The gradient editor: a live preview over a checkerboard, an opacity stop
 * strip above it and a colour stop strip below, with a draggable midpoint
 * between each pair of colour stops.
 */
export function openGradientEditor(
  definition: GradientDefinition,
  colours: { foreground: string; background: string },
  onApply: (next: GradientDefinition) => void,
): void {
  const draft = cloneGradient(definition);

  const body = document.createElement('div');
  body.className = 'pf-gradient-editor';

  const opacityStrip = document.createElement('div');
  opacityStrip.className = 'pf-stop-strip pf-stop-strip--opacity';

  const preview = document.createElement('canvas');
  preview.className = 'pf-gradient-preview';
  preview.width = 320;
  preview.height = 44;

  const colourStrip = document.createElement('div');
  colourStrip.className = 'pf-stop-strip pf-stop-strip--colour';

  const controls = document.createElement('div');
  controls.className = 'pf-gradient-controls';

  body.append(opacityStrip, preview, colourStrip, controls);

  let selected: { kind: 'colour' | 'opacity'; index: number } = { kind: 'colour', index: 0 };

  const paintPreview = (): void => {
    const ctx = preview.getContext('2d');
    if (!ctx) return;

    // Checkerboard first, so opacity stops are visible.
    ctx.clearRect(0, 0, preview.width, preview.height);
    for (let y = 0; y < preview.height; y += 8) {
      for (let x = 0; x < preview.width; x += 8) {
        ctx.fillStyle = ((x >> 3) + (y >> 3)) % 2 === 0 ? '#c8c8c8' : '#f0f0f0';
        ctx.fillRect(x, y, 8, 8);
      }
    }

    const lut = buildGradientLut(draft, {
      type: 'linear', reverse: false, dither: false, transparency: true,
      foreground: colours.foreground, background: colours.background,
    });
    const size = lut.length / 4;
    for (let x = 0; x < preview.width; x++) {
      const i = Math.round((x / (preview.width - 1)) * (size - 1)) * 4;
      ctx.fillStyle = `rgba(${Math.round(lut[i]!)}, ${Math.round(lut[i + 1]!)}, ${Math.round(lut[i + 2]!)}, ${lut[i + 3]! / 255})`;
      ctx.fillRect(x, 0, 1, preview.height);
    }
  };

  const sortStops = (): void => {
    draft.colourStops.sort((a, b) => a.position - b.position);
    draft.opacityStops.sort((a, b) => a.position - b.position);
    while (draft.midpoints.length < draft.colourStops.length - 1) draft.midpoints.push(0.5);
    draft.midpoints.length = Math.max(0, draft.colourStops.length - 1);
  };

  const buildControls = (): void => {
    controls.replaceChildren();

    const position = document.createElement('input');
    position.type = 'number';
    position.className = 'pf-input pf-input--compact';
    position.min = '0';
    position.max = '100';

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'pf-button';
    remove.textContent = 'Delete stop';

    const label = document.createElement('span');
    label.className = 'pf-field-label';

    if (selected.kind === 'colour') {
      const stop = draft.colourStops[selected.index];
      if (!stop) return;

      label.textContent = 'Colour stop';
      const colour = document.createElement('input');
      colour.type = 'color';
      colour.className = 'pf-colour';
      colour.value = stop.colour === 'FG' ? colours.foreground
        : stop.colour === 'BG' ? colours.background : stop.colour;
      colour.addEventListener('input', () => {
        stop.colour = colour.value;
        paintPreview();
        renderStops();
      });

      position.value = String(Math.round(stop.position * 100));
      position.addEventListener('change', () => {
        stop.position = Math.min(1, Math.max(0, Number(position.value) / 100));
        sortStops();
        paintPreview();
        renderStops();
      });

      remove.disabled = draft.colourStops.length <= 2;
      remove.addEventListener('click', () => {
        if (draft.colourStops.length <= 2) return;
        draft.colourStops.splice(selected.index, 1);
        selected = { kind: 'colour', index: 0 };
        sortStops();
        paintPreview();
        renderStops();
      });

      controls.append(label, colour, position, remove);
      return;
    }

    const stop = draft.opacityStops[selected.index];
    if (!stop) return;

    label.textContent = 'Opacity stop';
    const opacity = document.createElement('input');
    opacity.type = 'range';
    opacity.className = 'pf-range';
    opacity.min = '0';
    opacity.max = '100';
    opacity.value = String(Math.round(stop.opacity * 100));
    opacity.addEventListener('input', () => {
      stop.opacity = Number(opacity.value) / 100;
      paintPreview();
      renderStops();
    });

    position.value = String(Math.round(stop.position * 100));
    position.addEventListener('change', () => {
      stop.position = Math.min(1, Math.max(0, Number(position.value) / 100));
      sortStops();
      paintPreview();
      renderStops();
    });

    remove.disabled = draft.opacityStops.length <= 2;
    remove.addEventListener('click', () => {
      if (draft.opacityStops.length <= 2) return;
      draft.opacityStops.splice(selected.index, 1);
      selected = { kind: 'opacity', index: 0 };
      sortStops();
      paintPreview();
      renderStops();
    });

    controls.append(label, opacity, position, remove);
  };

  function makeHandle(kind: Handle['kind'], index: number, position: number, colour?: string): HTMLElement {
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = `pf-stop pf-stop--${kind}`;
    handle.style.left = `${position * 100}%`;
    if (colour) handle.style.setProperty('--stop-colour', colour);
    if (
      (kind === 'colour' && selected.kind === 'colour' && selected.index === index) ||
      (kind === 'opacity' && selected.kind === 'opacity' && selected.index === index)
    ) {
      handle.classList.add('is-selected');
    }

    const strip = kind === 'opacity' ? opacityStrip : colourStrip;

    handle.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);

      if (kind !== 'midpoint') {
        selected = { kind, index };
        renderStops();
      }

      const startY = event.clientY;
      let removing = false;

      const onMove = (move: PointerEvent): void => {
        const rect = strip.getBoundingClientRect();
        const t = Math.min(1, Math.max(0, (move.clientX - rect.left) / rect.width));

        if (kind === 'midpoint') {
          const lower = draft.colourStops[index]?.position ?? 0;
          const upper = draft.colourStops[index + 1]?.position ?? 1;
          const span = upper - lower;
          draft.midpoints[index] = span <= 0 ? 0.5 : Math.min(0.95, Math.max(0.05, (t - lower) / span));
        } else if (kind === 'colour') {
          const stop = draft.colourStops[index];
          if (stop) stop.position = t;
          removing = Math.abs(move.clientY - startY) > REMOVE_DISTANCE_PX;
        } else {
          const stop = draft.opacityStops[index];
          if (stop) stop.position = t;
          removing = Math.abs(move.clientY - startY) > REMOVE_DISTANCE_PX;
        }

        handle.classList.toggle('is-removing', removing);
        paintPreview();
      };

      const onUp = (): void => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);

        // Dragged well off the strip: remove it, as long as two remain.
        if (removing) {
          const list = kind === 'colour' ? draft.colourStops : draft.opacityStops;
          if (list.length > 2) {
            list.splice(index, 1);
            selected = { kind: kind === 'colour' ? 'colour' : 'opacity', index: 0 };
          }
        }
        sortStops();
        paintPreview();
        renderStops();
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });

    return handle;
  }

  function renderStops(): void {
    sortStops();
    colourStrip.replaceChildren();
    opacityStrip.replaceChildren();

    draft.colourStops.forEach((stop, index) => {
      const shown = stop.colour === 'FG' ? colours.foreground
        : stop.colour === 'BG' ? colours.background : stop.colour;
      colourStrip.appendChild(makeHandle('colour', index, stop.position, shown));
    });

    // Midpoints sit between each adjacent pair.
    for (let i = 0; i < draft.colourStops.length - 1; i++) {
      const lower = draft.colourStops[i]!.position;
      const upper = draft.colourStops[i + 1]!.position;
      const at = lower + (upper - lower) * (draft.midpoints[i] ?? 0.5);
      colourStrip.appendChild(makeHandle('midpoint', i, at));
    }

    draft.opacityStops.forEach((stop, index) => {
      const grey = Math.round(stop.opacity * 255);
      opacityStrip.appendChild(
        makeHandle('opacity', index, stop.position, `rgb(${grey}, ${grey}, ${grey})`),
      );
    });

    buildControls();
  }

  /** Clicking empty strip adds a stop there. */
  const addOnClick = (strip: HTMLElement, kind: 'colour' | 'opacity') => {
    strip.addEventListener('pointerdown', (event) => {
      if (event.target !== strip) return;
      const rect = strip.getBoundingClientRect();
      const t = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));

      if (kind === 'colour') {
        const lut = buildGradientLut(draft, {
          type: 'linear', reverse: false, dither: false, transparency: true,
          foreground: colours.foreground, background: colours.background,
        });
        const i = Math.round(t * (lut.length / 4 - 1)) * 4;
        const hex = (v: number) => Math.round(v).toString(16).padStart(2, '0');
        draft.colourStops.push({
          position: t,
          colour: `#${hex(lut[i]!)}${hex(lut[i + 1]!)}${hex(lut[i + 2]!)}`,
        });
      } else {
        draft.opacityStops.push({ position: t, opacity: 1 });
      }
      sortStops();
      paintPreview();
      renderStops();
    });
  };

  addOnClick(colourStrip, 'colour');
  addOnClick(opacityStrip, 'opacity');

  paintPreview();
  renderStops();

  openDialog({
    title: 'Gradient Editor',
    body,
    primaryLabel: 'OK',
    onPrimary: () => onApply(cloneGradient(draft)),
  });
}
