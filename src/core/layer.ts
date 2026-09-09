import type { BlendMode, Layer, LayerType } from './types';

let idCounter = 0;
let nameCounter = 0;

function nextId(): string {
  idCounter += 1;
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `layer-${idCounter}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface CreateLayerOptions {
  width: number;
  height: number;
  name?: string;
  x?: number;
  y?: number;
  opacity?: number;
  blendMode?: BlendMode;
  visible?: boolean;
  locked?: boolean;
  type?: LayerType;
  /** CSS colour to prefill the bitmap with. Omit for a transparent layer. */
  fill?: string;
}

/** Creates a layer with its own bitmap. The layer is not added to any document. */
export function createLayer(options: CreateLayerOptions): Layer {
  const width = Math.max(1, Math.round(options.width));
  const height = Math.max(1, Math.round(options.height));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not acquire a 2D context for a new layer.');

  if (options.fill) {
    ctx.fillStyle = options.fill;
    ctx.fillRect(0, 0, width, height);
  }

  nameCounter += 1;

  return {
    id: nextId(),
    name: options.name ?? `Layer ${nameCounter}`,
    canvas,
    ctx,
    x: options.x ?? 0,
    y: options.y ?? 0,
    opacity: options.opacity ?? 1,
    blendMode: options.blendMode ?? 'normal',
    visible: options.visible ?? true,
    locked: options.locked ?? false,
    type: options.type ?? 'raster',
  };
}

/** Bounds of a layer's bitmap in document coordinates. */
export function layerBounds(layer: Layer): { x: number; y: number; width: number; height: number } {
  return { x: layer.x, y: layer.y, width: layer.canvas.width, height: layer.canvas.height };
}
