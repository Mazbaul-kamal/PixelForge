import { childrenOf } from './compositor';
import type { PixelDocument } from './document';
import { blendModeToPsd } from './psd-blend-modes';
import type { Layer } from './types';

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
  return {
    width: doc.width,
    height: doc.height,
    canvas: composite,
    children: childrenOf(doc.layers, undefined).map((layer) => toWriteLayer(doc, layer)),
  };
}
