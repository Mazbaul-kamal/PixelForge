import {
  ADJUSTMENT_NAMES, defaultParams, histogram,
} from '../core/adjustments';
import type { AdjustmentData, AdjustmentKind, CurvePoint } from '../core/adjustments';
import {
  commitAdjustmentLayer, insertAdjustmentLayer, makeAdjustmentLayer, updateAdjustmentLayer,
} from '../core/adjustment-ops';
import type { Compositor } from '../core/compositor';
import type { PixelDocument } from '../core/document';
import type { History } from '../core/history';
import type { Layer } from '../core/types';
import { createCurveEditor, createHistogram } from './curve-editor';
import { openParameterDialog } from './dialogs/parameter-dialog';
import type { ParameterControl, ParameterValues } from './dialogs/parameter-dialog';

const slider = (
  id: string, label: string, min: number, max: number, unit = '', step = 1,
): ParameterControl => ({ kind: 'slider', id, label, min, max, unit, step });

/** The controls each adjustment shows. */
function controlsFor(kind: AdjustmentKind): ParameterControl[] {
  switch (kind) {
    case 'brightness-contrast':
      return [slider('brightness', 'Brightness', -150, 150), slider('contrast', 'Contrast', -100, 100)];
    case 'levels':
      return [
        slider('black', 'Black point', 0, 254),
        slider('gamma', 'Gamma', 0.1, 4, '', 0.01),
        slider('white', 'White point', 1, 255),
        slider('outputLow', 'Output low', 0, 255),
        slider('outputHigh', 'Output high', 0, 255),
      ];
    case 'hue-saturation':
      return [
        {
          kind: 'select', id: 'range', label: 'Range',
          choices: [
            { value: 'master', label: 'Master' }, { value: 'reds', label: 'Reds' },
            { value: 'yellows', label: 'Yellows' }, { value: 'greens', label: 'Greens' },
            { value: 'cyans', label: 'Cyans' }, { value: 'blues', label: 'Blues' },
            { value: 'magentas', label: 'Magentas' },
          ],
        },
        slider('hue', 'Hue', -180, 180, '°'),
        slider('saturation', 'Saturation', -100, 100, '%'),
        slider('lightness', 'Lightness', -100, 100, '%'),
      ];
    case 'colour-balance':
      return [
        slider('shadowRed', 'Shadows red', -100, 100),
        slider('shadowGreen', 'Shadows green', -100, 100),
        slider('shadowBlue', 'Shadows blue', -100, 100),
        slider('midRed', 'Midtones red', -100, 100),
        slider('midGreen', 'Midtones green', -100, 100),
        slider('midBlue', 'Midtones blue', -100, 100),
        slider('highRed', 'Highlights red', -100, 100),
        slider('highGreen', 'Highlights green', -100, 100),
        slider('highBlue', 'Highlights blue', -100, 100),
      ];
    case 'black-white':
      return [
        slider('red', 'Reds', 0, 2, '', 0.05), slider('yellow', 'Yellows', 0, 2, '', 0.05),
        slider('green', 'Greens', 0, 2, '', 0.05), slider('cyan', 'Cyans', 0, 2, '', 0.05),
        slider('blue', 'Blues', 0, 2, '', 0.05), slider('magenta', 'Magentas', 0, 2, '', 0.05),
      ];
    case 'exposure':
      return [
        slider('exposure', 'Exposure', -5, 5, ' stops', 0.05),
        slider('offset', 'Offset', -0.5, 0.5, '', 0.01),
        slider('gamma', 'Gamma', 0.1, 4, '', 0.01),
      ];
    case 'vibrance':
      return [slider('vibrance', 'Vibrance', -100, 100), slider('saturation', 'Saturation', -100, 100)];
    case 'photo-filter':
      return [
        { kind: 'colour', id: 'colour', label: 'Colour' },
        slider('density', 'Density', 0, 100, '%'),
        { kind: 'checkbox', id: 'preserveLuminosity', label: 'Preserve luminosity' },
      ];
    case 'threshold':
      return [slider('level', 'Threshold', 1, 254)];
    case 'posterize':
      return [slider('levels', 'Levels', 2, 32)];
    case 'curves':
    case 'invert':
      return [];
  }
}

export interface AdjustmentDeps {
  doc: PixelDocument;
  history: History;
  compositor: Compositor;
  onChanged: () => void;
}

/**
 * Opens an adjustment layer's dialog.
 *
 * The layer is placed straight away so the preview is the real composite, and
 * only the final parameters reach history, as one entry.
 */
export function openAdjustment(
  deps: AdjustmentDeps,
  kind: AdjustmentKind,
  existing?: Layer,
): void {
  const { doc, history, compositor, onChanged } = deps;

  const layer = existing ?? makeAdjustmentLayer(kind);
  const startingParams = existing?.adjustment?.params ?? defaultParams(kind);
  const previous: AdjustmentData | undefined = existing?.adjustment;

  if (!existing) insertAdjustmentLayer(doc, layer);

  // Curves gets its own editor rather than a row of sliders.
  const extra = document.createElement('div');
  const curveState: Record<string, CurvePoint[]> = {
    rgb: (startingParams['rgb'] as CurvePoint[]) ?? [[0, 0], [255, 255]],
  };

  let apply: (values: ParameterValues, enabled: boolean) => void = () => {};

  if (kind === 'curves') {
    const editor = createCurveEditor(curveState['rgb']!, (points) => {
      curveState['rgb'] = points;
      apply({}, true);
    });
    extra.appendChild(editor.element);
  }

  if (kind === 'levels') {
    compositor.composeIfDirty();
    const source = compositor.ctx.getImageData(0, 0, doc.width, doc.height);
    extra.appendChild(createHistogram(histogram(source.data).luma));
  }

  const paramsFrom = (values: ParameterValues): AdjustmentData => ({
    kind,
    params: kind === 'curves'
      ? { ...startingParams, rgb: curveState['rgb'] }
      : { ...startingParams, ...values },
  });

  apply = (values, enabled) => {
    layer.adjustment = enabled ? paramsFrom(values) : { kind, params: defaultParams(kind) };
    layer.visible = enabled;
    compositor.markDirty();
    onChanged();
  };

  openParameterDialog({
    title: ADJUSTMENT_NAMES[kind],
    controls: controlsFor(kind),
    initial: startingParams as ParameterValues,
    extra: extra.childElementCount > 0 ? extra : undefined,
    onPreview: apply,
    onCommit: (values) => {
      layer.visible = true;
      const data = paramsFrom(values);
      if (existing) updateAdjustmentLayer(doc, history, layer.id, data);
      else commitAdjustmentLayer(doc, history, layer, data);
      onChanged();
    },
    onCancel: () => {
      layer.visible = true;
      if (existing) layer.adjustment = previous;
      else doc.removeLayer(layer.id);
      compositor.markDirty();
      onChanged();
    },
  });
}

export const ADJUSTMENT_KINDS: readonly AdjustmentKind[] = [
  'brightness-contrast', 'levels', 'curves', 'exposure', 'vibrance',
  'hue-saturation', 'colour-balance', 'black-white', 'photo-filter',
  'invert', 'threshold', 'posterize',
];
