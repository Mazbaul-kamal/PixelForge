import { fillThroughMasks, patternPaint, solidPaint } from '../core/fill-ops';
import type { FloodRunner } from '../core/flood-runner';
import type { PatternDefinition } from '../core/patterns';
import { SelectionMask } from '../core/selection';
import { BLEND_MODES } from '../core/types';
import type { BlendMode } from '../core/types';
import { paintableLayer } from './stroke-tool';
import type { Tool, ToolContext, ToolPointer } from './types';

export interface BucketDeps {
  runner: FloodRunner;
  track: <T>(label: string, work: Promise<T>) => Promise<T>;
  /** Patterns available to fill with, including any defined from a selection. */
  patterns: () => readonly PatternDefinition[];
  onFilled: () => void;
}

function blendChoices() {
  return BLEND_MODES.map((mode) => ({
    value: mode,
    label: mode.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
  }));
}

/**
 * Paint bucket. It reuses the wand's flood fill to get a coverage mask, then
 * fills THROUGH that mask rather than writing pixel values, so an
 * anti-aliased boundary blends instead of leaving a pale fringe.
 */
export function createBucketTool(deps: BucketDeps): Tool {
  return {
    id: 'bucket',
    name: 'Paint Bucket',
    shortcut: 'G',
    cursor: 'crosshair',

    options: [
      {
        type: 'select',
        id: 'source',
        label: 'Fill',
        default: 'foreground',
        choices: [
          { value: 'foreground', label: 'Foreground colour' },
          { value: 'pattern', label: 'Pattern' },
        ],
      },
      {
        type: 'select',
        id: 'pattern',
        label: 'Pattern',
        default: 'checker',
        choices: [
          { value: 'checker', label: 'Checkerboard' },
          { value: 'stripes', label: 'Diagonal stripes' },
          { value: 'dots', label: 'Dots' },
          { value: 'grid', label: 'Grid' },
          { value: 'custom', label: 'From selection' },
        ],
      },
      { type: 'slider', id: 'tolerance', label: 'Tolerance', min: 0, max: 100, default: 30 },
      { type: 'slider', id: 'opacity', label: 'Opacity', min: 0, max: 100, default: 100, unit: '%' },
      { type: 'select', id: 'blendMode', label: 'Mode', default: 'normal', choices: blendChoices() },
      { type: 'checkbox', id: 'contiguous', label: 'Contiguous', default: true },
      { type: 'checkbox', id: 'sampleAllLayers', label: 'Sample all layers', default: false },
      { type: 'checkbox', id: 'antiAlias', label: 'Anti-alias', default: true },
    ],

    onPointerDown(context: ToolContext, pointer: ToolPointer): void {
      const layer = paintableLayer(context);
      if (!layer) return;

      const source = context.readSourcePixels(
        context.options.get<boolean>('sampleAllLayers'),
      );
      if (!source) return;

      const doc = context.doc;
      const selection = context.selection;
      const usePattern = context.options.get<string>('source') === 'pattern';
      const patternId = context.options.get<string>('pattern');
      const opacity = context.options.get<number>('opacity') / 100;
      const blendMode = context.options.get<string>('blendMode') as BlendMode;

      const scan = deps.runner.run({
        kind: 'wand',
        pixels: source.data,
        width: source.width,
        height: source.height,
        tolerance: context.options.get<number>('tolerance'),
        antiAlias: context.options.get<boolean>('antiAlias'),
        contiguous: context.options.get<boolean>('contiguous'),
        seedX: Math.floor(pointer.doc.x),
        seedY: Math.floor(pointer.doc.y),
      });

      void deps.track('Filling…', scan).then((data) => {
        const region = new SelectionMask(doc.width, doc.height, data);
        if (region.isEmpty()) return;

        const tile = usePattern
          ? deps.patterns().find((p) => p.id === patternId) ?? deps.patterns()[0]
          : null;
        const paint = tile ? patternPaint(tile.canvas) : solidPaint(context.colours.foreground);

        fillThroughMasks(
          doc, context.history, layer, paint,
          // Both the flood region and the active selection restrict the fill.
          [region, selection],
          { opacity, blendMode },
          usePattern ? 'Pattern Fill' : 'Paint Bucket',
        );
        deps.onFilled();
        context.invalidateComposite();
      });
    },

    onPointerMove(): void {
      // The bucket acts on click alone.
    },

    onPointerUp(): void {
      // Nothing to finish.
    },
  };
}
