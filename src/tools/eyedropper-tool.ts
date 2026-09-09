import { averageSample, rgbToHex } from '../core/colour-utils';
import type { Point } from '../core/types';
import type { Tool, ToolContext, ToolPointer } from './types';

export interface SampledColour {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
  readonly hex: string;
}

export interface EyedropperDeps {
  /** Reports the pixel under the cursor, for the Info readout. */
  onHover: (sample: SampledColour | null) => void;
}

const RING_RADIUS = 26;

/** Sample sizes offered, in pixels along one edge. */
const SIZES = [1, 3, 5, 11, 31, 51, 101];

export function createEyedropperTool(deps: EyedropperDeps): Tool {
  let hover: Point | null = null;
  let current: SampledColour | null = null;
  /** The colour the swatch held before this sampling session started. */
  let previous: string | null = null;
  let sampling = false;

  const sampleAt = (context: ToolContext, at: Point): SampledColour | null => {
    const source = context.readSourcePixels(
      context.options.get<string>('source') !== 'layer',
    );
    if (!source) return null;

    const x = Math.floor(at.x);
    const y = Math.floor(at.y);
    if (x < 0 || y < 0 || x >= source.width || y >= source.height) return null;

    const size = Number(context.options.get<string>('size'));
    const averaged = averageSample(source.data, source.width, source.height, x, y, size);
    return { ...averaged, hex: rgbToHex(averaged) };
  };

  const apply = (context: ToolContext, pointer: ToolPointer): void => {
    const sample = sampleAt(context, pointer.doc);
    if (!sample) return;
    current = sample;

    // Alt drops the colour into the background swatch instead.
    if (pointer.altKey) context.colours.background = sample.hex;
    else context.colours.foreground = sample.hex;
  };

  return {
    id: 'eyedropper',
    name: 'Eyedropper',
    shortcut: 'I',
    cursor: 'none',

    options: [
      {
        type: 'select', id: 'size', label: 'Sample size', default: '1',
        choices: SIZES.map((size) => ({
          value: String(size),
          label: size === 1 ? 'Point sample' : `${size} × ${size} average`,
        })),
      },
      {
        type: 'select', id: 'source', label: 'Sample', default: 'all',
        choices: [
          { value: 'layer', label: 'Current layer' },
          { value: 'all', label: 'All layers' },
        ],
      },
    ],

    activate(context: ToolContext): void {
      previous = context.colours.foreground;
    },

    onPointerDown(context: ToolContext, pointer: ToolPointer): void {
      sampling = true;
      previous = pointer.altKey ? context.colours.background : context.colours.foreground;
      apply(context, pointer);
      context.requestRender();
    },

    onPointerMove(context: ToolContext, pointer: ToolPointer): void {
      hover = pointer.doc;
      if (sampling) apply(context, pointer);
      else current = sampleAt(context, pointer.doc);

      deps.onHover(current);
      context.requestRender();
    },

    onPointerUp(context: ToolContext): void {
      sampling = false;
      context.requestRender();
    },

    drawOverlay(ctx: CanvasRenderingContext2D, context: ToolContext): void {
      if (!hover || !current) return;

      const centre = context.viewport.docToScreen(hover.x, hover.y);

      ctx.save();
      // A ring split between the colour that was set and the one under the
      // cursor, so the change is visible before the click.
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, RING_RADIUS, -Math.PI / 2, Math.PI / 2);
      ctx.closePath();
      ctx.fillStyle = current.hex;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(centre.x, centre.y, RING_RADIUS, Math.PI / 2, (Math.PI * 3) / 2);
      ctx.closePath();
      ctx.fillStyle = previous ?? context.colours.foreground;
      ctx.fill();

      // Light over dark, so the ring reads against any image.
      for (const [radius, colour, width] of [
        [RING_RADIUS + 1, 'rgba(0, 0, 0, 0.55)', 3],
        [RING_RADIUS, 'rgba(255, 255, 255, 0.95)', 1.5],
        [RING_RADIUS - 6, 'rgba(0, 0, 0, 0.35)', 1],
      ] as const) {
        ctx.beginPath();
        ctx.arc(centre.x, centre.y, radius, 0, Math.PI * 2);
        ctx.lineWidth = width;
        ctx.strokeStyle = colour;
        ctx.stroke();
      }
      ctx.restore();
    },

    deactivate(): void {
      sampling = false;
      hover = null;
      current = null;
      deps.onHover(null);
    },
  };
}
