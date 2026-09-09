import { FloodRunner } from '../core/flood-runner';
import type { SelectionMask } from '../core/selection';
import { SelectionMask as Mask } from '../core/selection';
import { combineModeFor, commitShapeSelection, selectionOptions } from './selection-shape-tool';
import type { Tool, ToolContext, ToolPointer } from './types';

export interface WandDeps {
  runner: FloodRunner;
  /** Wraps long scans so the UI can show that something is happening. */
  track: <T>(label: string, work: Promise<T>) => Promise<T>;
}

/**
 * Magic wand. The scan itself lives in flood-select.ts so the paint bucket can
 * reuse exactly the same matching, and runs in a worker for large documents.
 */
export function createMagicWandTool(deps: WandDeps): Tool {
  return {
    id: 'magic-wand',
    name: 'Magic Wand',
    shortcut: 'W',
    cursor: 'crosshair',

    options: [
      { type: 'slider', id: 'tolerance', label: 'Tolerance', min: 0, max: 100, default: 30 },
      { type: 'checkbox', id: 'contiguous', label: 'Contiguous', default: true },
      { type: 'checkbox', id: 'sampleAllLayers', label: 'Sample all layers', default: false },
      ...selectionOptions(),
    ],

    onPointerDown(context: ToolContext, pointer: ToolPointer): void {
      const source = context.readSourcePixels(
        context.options.get<boolean>('sampleAllLayers'),
      );
      if (!source) return;

      const base: SelectionMask | null = context.selection;
      const mode = combineModeFor(context, pointer);
      const doc = context.doc;

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

      void deps.track('Selecting…', scan).then((data) => {
        const shape = new Mask(doc.width, doc.height, data);
        commitShapeSelection(context, base, shape, mode, 'Magic Wand');
        context.requestRender();
      });
    },

    onPointerMove(): void {
      // The wand acts on click alone.
    },

    onPointerUp(): void {
      // Nothing to finish.
    },
  };
}
