import type { PixelDocument } from '../core/document';
import type { FilterRunner } from '../core/filter-runner';
import { defaultFilterParams, FILTER_NAMES } from '../core/filters';
import type { FilterKind, FilterParams } from '../core/filters';
import type { History } from '../core/history';
import { canEditLayer } from '../core/layer-ops';
import { captureLayerPixels, restoreLayerPixels } from '../core/snapshot';
import type { Rect } from '../core/types';
import { openParameterDialog } from './dialogs/parameter-dialog';
import type { ParameterControl, ParameterValues } from './dialogs/parameter-dialog';

function controlsFor(kind: FilterKind): ParameterControl[] {
  const slider = (
    id: string, label: string, min: number, max: number, unit = '', step = 1,
  ): ParameterControl => ({ kind: 'slider', id, label, min, max, unit, step });

  switch (kind) {
    case 'gaussian-blur': return [slider('radius', 'Radius', 0, 100, 'px')];
    case 'motion-blur': return [
      slider('distance', 'Distance', 1, 200, 'px'), slider('angle', 'Angle', -180, 180, '°'),
    ];
    case 'sharpen': return [slider('amount', 'Amount', 0, 300, '%')];
    case 'unsharp-mask': return [
      slider('amount', 'Amount', 0, 300, '%'), slider('radius', 'Radius', 0.5, 50, 'px', 0.5),
      slider('threshold', 'Threshold', 0, 60),
    ];
    case 'add-noise': return [
      slider('amount', 'Amount', 0, 100), { kind: 'checkbox', id: 'monochrome', label: 'Monochrome' },
    ];
    case 'median': return [slider('radius', 'Radius', 1, 8, 'px')];
    case 'pixelate': return [slider('size', 'Cell size', 2, 120, 'px')];
    case 'high-pass': return [slider('radius', 'Radius', 0.5, 60, 'px', 0.5)];
    case 'emboss': return [
      slider('angle', 'Angle', -180, 180, '°'), slider('depth', 'Depth', 1, 20, 'px'),
      slider('amount', 'Amount', 10, 500, '%'),
    ];
    case 'find-edges': return [];
    case 'surface-blur': return [
      slider('radius', 'Radius', 1, 20, 'px'), slider('threshold', 'Threshold', 2, 100),
    ];
    case 'twirl': return [
      slider('angle', 'Angle', -720, 720, '°'), slider('radius', 'Radius', 5, 100, '%'),
    ];
    case 'vignette': return [
      slider('amount', 'Amount', -100, 100, '%'), slider('midpoint', 'Midpoint', 5, 95, '%'),
      slider('roundness', 'Roundness', 0, 100, '%'),
    ];
  }
}

export interface FilterDeps {
  doc: PixelDocument;
  history: History;
  runner: FilterRunner;
  /** The part of the document currently on screen, in document coordinates. */
  visibleRect: () => Rect;
  onChanged: () => void;
  notify: (title: string, detail?: string) => void;
}

/**
 * Opens a filter dialog.
 *
 * Previews run over the visible region only, so previewing a very large image
 * stays interactive; the committed run covers the whole layer. Cancel restores
 * the snapshot taken before anything was previewed, so it is exact.
 */
export function openFilter(deps: FilterDeps, kind: FilterKind): void {
  const { doc, history, runner } = deps;
  const layer = doc.getActiveLayer();
  if (!canEditLayer(layer) || !layer) {
    deps.notify('No layer to filter.', 'Select an unlocked layer first.');
    return;
  }

  const before = captureLayerPixels(layer);
  let pendingRun: number | null = null;

  /** The region to process, in layer-local coordinates. */
  const regionFor = (previewOnly: boolean): Rect => {
    if (!previewOnly) return { x: 0, y: 0, width: layer.canvas.width, height: layer.canvas.height };

    const visible = deps.visibleRect();
    const left = Math.max(0, Math.floor(visible.x - layer.x));
    const top = Math.max(0, Math.floor(visible.y - layer.y));
    const right = Math.min(layer.canvas.width, Math.ceil(visible.x + visible.width - layer.x));
    const bottom = Math.min(layer.canvas.height, Math.ceil(visible.y + visible.height - layer.y));
    return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
  };

  const run = (params: FilterParams, previewOnly: boolean, done?: () => void): void => {
    // Always start from the untouched pixels, so previews never compound.
    restoreLayerPixels(doc, before);

    const region = regionFor(previewOnly);
    const image = layer.ctx.getImageData(region.x, region.y, region.width, region.height);

    if (pendingRun !== null) runner.cancel(pendingRun);
    const { id, result } = runner.run({
      kind, params, pixels: image.data, width: region.width, height: region.height,
    });
    pendingRun = id;

    void result.then((pixels) => {
      if (pendingRun !== id) return;
      pendingRun = null;
      if (!pixels) return;

      const output = layer.ctx.createImageData(region.width, region.height);
      output.data.set(pixels);
      applyThroughSelection(output, region);
      layer.ctx.putImageData(output, region.x, region.y);
      deps.onChanged();
      done?.();
    });
  };

  /** Restricts the result to the active selection. */
  const applyThroughSelection = (image: ImageData, region: Rect): void => {
    const selection = doc.selection;
    if (!selection) return;

    const original = layer.ctx.getImageData(region.x, region.y, region.width, region.height).data;
    for (let y = 0; y < region.height; y++) {
      for (let x = 0; x < region.width; x++) {
        const coverage = selection.valueAt(
          region.x + x + layer.x, region.y + y + layer.y,
        ) / 255;
        if (coverage >= 1) continue;

        const i = (y * region.width + x) * 4;
        for (let c = 0; c < 4; c++) {
          image.data[i + c] = original[i + c]! + (image.data[i + c]! - original[i + c]!) * coverage;
        }
      }
    }
  };

  const dialog = openParameterDialog({
    title: FILTER_NAMES[kind],
    controls: controlsFor(kind),
    initial: defaultFilterParams(kind) as ParameterValues,
    onPreview: (values, enabled) => {
      if (!enabled) {
        restoreLayerPixels(doc, before);
        deps.onChanged();
        return;
      }
      dialog.setBusy(true, `Applying ${FILTER_NAMES[kind]}…`);
      run(values as FilterParams, true, () => dialog.setBusy(false));
    },
    onCommit: (values) => {
      dialog.setBusy(true, `Applying ${FILTER_NAMES[kind]}…`);
      run(values as FilterParams, false, () => {
        dialog.setBusy(false);
        const after = captureLayerPixels(layer);
        history.push(
          FILTER_NAMES[kind],
          () => restoreLayerPixels(doc, before),
          () => restoreLayerPixels(doc, after),
        );
        deps.onChanged();
      });
    },
    onCancel: () => {
      if (pendingRun !== null) runner.cancel(pendingRun);
      restoreLayerPixels(doc, before);
      deps.onChanged();
    },
    onRequestCancelRun: () => {
      if (pendingRun !== null) runner.cancel(pendingRun);
      pendingRun = null;
      dialog.setBusy(false);
    },
  });
}

export const FILTER_KINDS: readonly FilterKind[] = [
  'gaussian-blur', 'motion-blur', 'sharpen', 'unsharp-mask',
  'add-noise', 'median', 'pixelate', 'high-pass',
  'emboss', 'find-edges', 'surface-blur', 'twirl', 'vignette',
];
