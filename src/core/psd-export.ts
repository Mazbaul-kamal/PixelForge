import { childrenOf } from './compositor';
import type { PixelDocument } from './document';
import { blendModeToPsd } from './psd-blend-modes';
import type { Layer } from './types';
import { hasActiveStyles } from './layer-styles';
import type { LayerStyles } from './layer-styles';
import { stylesToPsdEffects } from './psd-effects';
import type { PsdEffects } from './psd-effects';
import { buildSidecar, encodeSidecar, isEmptySidecar } from './psd-metadata';

interface PsdWriteLayer {
  name: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  opacity: number;
  blendMode: string;
  hidden: boolean;
  clipping: boolean;
  opened?: boolean;
  canvas?: HTMLCanvasElement;
  children?: PsdWriteLayer[];
  mask?: { left: number; top: number; right: number; bottom: number; canvas: HTMLCanvasElement };
  effects?: PsdEffects;
}

/**
 * Depth-first index of each written layer, which is how the sidecar keys its
 * styles: PSD layer ids are not stable across a round trip, but the order the
 * tree is written in is exactly the order it is read back in.
 */
function collectStyles(
  doc: PixelDocument, layers: readonly Layer[], into: Record<string, LayerStyles>,
  counter: { next: number },
): void {
  for (const layer of layers) {
    const index = counter.next;
    counter.next += 1;
    if (layer.styles && hasActiveStyles(layer)) into[String(index)] = layer.styles;
    if (layer.type === 'group') {
      collectStyles(doc, childrenOf(doc.layers, layer.id), into, counter);
    }
  }
}

function toWriteLayer(doc: PixelDocument, layer: Layer): PsdWriteLayer {
  const isGroup = layer.type === 'group';

  const entry: PsdWriteLayer = {
    name: layer.name,
    left: layer.x,
    top: layer.y,
    right: layer.x + layer.canvas.width,
    bottom: layer.y + layer.canvas.height,
    opacity: Math.min(1, Math.max(0, layer.opacity)),
    blendMode: blendModeToPsd(layer.blendMode),
    hidden: !layer.visible,
    clipping: layer.clipped === true,
  };

  if (layer.styles && hasActiveStyles(layer)) {
    const effects = stylesToPsdEffects(layer.styles, layer.stylesEnabled !== false);
    if (effects) entry.effects = effects;
  }

  if (isGroup) {
    entry.opened = layer.collapsed !== true;
    entry.children = childrenOf(doc.layers, layer.id).map((child) => toWriteLayer(doc, child));
    return entry;
  }

  entry.canvas = layer.canvas;
  if (layer.mask) {
    entry.mask = {
      left: layer.x,
      top: layer.y,
      right: layer.x + layer.mask.width,
      bottom: layer.y + layer.mask.height,
      canvas: layer.mask,
    };
  }
  return entry;
}

/**
 * Builds the structure ag-psd writes.
 *
 * The flattened composite goes in as well, because plenty of applications only
 * read that and would otherwise show nothing.
 */
export function buildPsd(
  doc: PixelDocument,
  composite: HTMLCanvasElement,
): Record<string, unknown> {
  const styles: Record<string, LayerStyles> = {};
  collectStyles(doc, childrenOf(doc.layers, undefined), styles, { next: 0 });

  const sidecar = buildSidecar(styles, doc.paths, doc.activePathId, doc.guides);
  const resources: Record<string, unknown> = {};

  // Guides have a real home in a PSD, so they go there as well as in the
  // sidecar; Photoshop will show them.
  if (doc.guides.length > 0) {
    resources.gridAndGuidesInformation = {
      guides: doc.guides.map((guide) => ({
        location: guide.position,
        direction: guide.axis === 'x' ? 'vertical' : 'horizontal',
      })),
    };
  }
  if (!isEmptySidecar(sidecar)) resources.xmpMetadata = encodeSidecar(sidecar);

  const psd: Record<string, unknown> = {
    width: doc.width,
    height: doc.height,
    canvas: composite,
    children: childrenOf(doc.layers, undefined).map((layer) => toWriteLayer(doc, layer)),
  };
  if (Object.keys(resources).length > 0) psd.imageResources = resources;
  return psd;
}
