import type { PixelDocument } from '../core/document';
import type { History } from '../core/history';
import { defaultStyles, hasActiveStyles } from '../core/layer-styles';
import type { LayerStyles } from '../core/layer-styles';
import { openLayerStyleDialog } from './dialogs/layer-style-dialog';

export interface LayerStyleDeps {
  readonly doc: PixelDocument;
  readonly history: History;
  /** Redraws without recording anything, for the live preview. */
  readonly repaint: () => void;
  /** Records the finished change and refreshes the panels. */
  readonly changed: () => void;
  readonly notify: (message: string, detail?: string) => void;
}

/**
 * Opens the effects editor for the active layer.
 *
 * The preview writes straight onto the layer so the document shows the real
 * composite, and the original is put back before the committed value goes
 * through history — otherwise undo would return to a previewed state that the
 * user never chose.
 */
export function openLayerStyles(deps: LayerStyleDeps): void {
  const { doc, history } = deps;
  const layer = doc.getActiveLayer();
  if (!layer) {
    deps.notify('Select a layer first.');
    return;
  }
  if (layer.type === 'adjustment') {
    deps.notify('Adjustment layers cannot take effects.', 'They have no pixels of their own.');
    return;
  }

  const original = layer.styles;
  const originalEnabled = layer.stylesEnabled;

  const restore = (): void => {
    if (original) layer.styles = original;
    else delete layer.styles;
    layer.stylesEnabled = originalEnabled;
  };

  openLayerStyleDialog({
    styles: layer.styles,
    onPreview: (styles) => {
      layer.styles = styles;
      layer.stylesEnabled = true;
      deps.repaint();
    },
    onCommit: (styles) => {
      restore();
      history.transaction('Layer Style', () => {
        layer.styles = styles;
        layer.stylesEnabled = true;
      });
      deps.changed();
    },
    onCancel: () => {
      restore();
      deps.repaint();
    },
  });
}

/** Turns every effect on the active layer off, or back on. */
export function toggleLayerStyles(deps: LayerStyleDeps): void {
  const layer = deps.doc.getActiveLayer();
  if (!layer?.styles) {
    deps.notify('That layer has no effects yet.');
    return;
  }
  const enable = layer.stylesEnabled === false;
  deps.history.transaction(enable ? 'Show Effects' : 'Hide Effects', () => {
    layer.stylesEnabled = enable;
  });
  deps.changed();
}

/** Removes the effects entirely. */
export function clearLayerStyles(deps: LayerStyleDeps): void {
  const layer = deps.doc.getActiveLayer();
  if (!layer || !hasActiveStyles(layer)) {
    deps.notify('That layer has no effects to clear.');
    return;
  }
  deps.history.transaction('Clear Effects', () => {
    layer.styles = defaultStyles();
    layer.stylesEnabled = true;
  });
  deps.changed();
}

export type { LayerStyles };
