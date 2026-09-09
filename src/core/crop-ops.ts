import type { PixelDocument } from './document';
import type { History } from './history';
import { createLayer } from './layer';
import type { Rect } from './types';

/**
 * The largest axis-aligned rectangle that fits inside a w x h rectangle after
 * it is rotated by `angle`. This is what keeps a straightened photo free of
 * transparent corners.
 */
export function largestInscribedRect(
  width: number,
  height: number,
  angle: number,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };

  const a = Math.abs(angle) % Math.PI;
  const theta = a > Math.PI / 2 ? Math.PI - a : a;
  const sin = Math.sin(theta);
  const cos = Math.cos(theta);

  const widthIsLonger = width >= height;
  const longSide = widthIsLonger ? width : height;
  const shortSide = widthIsLonger ? height : width;

  if (shortSide <= 2 * sin * cos * longSide || Math.abs(sin - cos) < 1e-10) {
    // Half-constrained: the solution touches the midpoint of the short side.
    const x = 0.5 * shortSide;
    return widthIsLonger
      ? { width: sin === 0 ? width : x / sin, height: cos === 0 ? height : x / cos }
      : { width: cos === 0 ? width : x / cos, height: sin === 0 ? height : x / sin };
  }

  const cosDouble = cos * cos - sin * sin;
  return {
    width: (width * cos - height * sin) / cosDouble,
    height: (height * cos - width * sin) / cosDouble,
  };
}

export interface CropOptions {
  /** When false, bitmaps are kept and only the bounds and offsets change. */
  readonly deletePixels: boolean;
  /** Radians. Non-zero rotation always bakes pixels. */
  readonly angle?: number;
  /** Resample the result to this width in pixels. 0 keeps the crop size. */
  readonly resampleWidth?: number;
}

/**
 * Applies a crop as one history entry.
 *
 * Without rotation and with deletePixels off this is purely structural: layer
 * bitmaps are untouched and only the document bounds and the layer offsets
 * move, so undoing and re-cropping recovers everything that was hidden.
 */
export function applyCrop(
  doc: PixelDocument,
  history: History,
  rect: Rect,
  options: CropOptions,
): boolean {
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const left = Math.round(rect.x);
  const top = Math.round(rect.y);
  const angle = options.angle ?? 0;

  const resampleWidth = Math.round(options.resampleWidth ?? 0);
  const resamples = resampleWidth > 0 && resampleWidth !== width;

  // An unchanged rectangle is still work to do if a resample was asked for.
  if (
    width === doc.width && height === doc.height &&
    left === 0 && top === 0 && angle === 0 && !resamples
  ) {
    return false;
  }

  return history.transaction(angle !== 0 ? 'Straighten and Crop' : 'Crop', () => {
    if (angle !== 0) {
      rotateLayers(doc, angle);
    }

    for (const layer of doc.layers) {
      if (!options.deletePixels && angle === 0) {
        // Structural only: the bitmap keeps every pixel it had.
        layer.x -= left;
        layer.y -= top;
        continue;
      }

      const cropped = createLayer({
        name: layer.name,
        width,
        height,
        opacity: layer.opacity,
        blendMode: layer.blendMode,
        visible: layer.visible,
        locked: layer.locked,
        type: layer.type,
      });
      cropped.ctx.drawImage(layer.canvas, layer.x - left, layer.y - top);

      layer.canvas = cropped.canvas;
      layer.ctx = cropped.ctx;
      layer.x = 0;
      layer.y = 0;
    }

    doc.width = width;
    doc.height = height;

    if (resamples) {
      resampleDocument(
        doc,
        resampleWidth,
        Math.max(1, Math.round((height * resampleWidth) / width)),
      );
    }

    // A crop invalidates any selection, which was in the old coordinate space.
    doc.selection = null;
    doc.pristine = false;
  });
}

/** Rotates every layer about the document centre, baking the result. */
function rotateLayers(doc: PixelDocument, angle: number): void {
  const centreX = doc.width / 2;
  const centreY = doc.height / 2;

  for (const layer of doc.layers) {
    const rotated = document.createElement('canvas');
    rotated.width = doc.width;
    rotated.height = doc.height;

    const ctx = rotated.getContext('2d');
    if (!ctx) continue;

    ctx.translate(centreX, centreY);
    ctx.rotate(angle);
    ctx.translate(-centreX, -centreY);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(layer.canvas, layer.x, layer.y);

    const context = rotated.getContext('2d');
    if (!context) continue;
    layer.canvas = rotated;
    layer.ctx = context;
    layer.x = 0;
    layer.y = 0;
  }
}

/**
 * The crop a straighten produces: the document rotated by `angle`, then the
 * biggest rectangle inside it that contains no transparent corner.
 */
export function straightenRect(doc: PixelDocument, angle: number): Rect {
  const inscribed = largestInscribedRect(doc.width, doc.height, angle);
  return {
    x: Math.round((doc.width - inscribed.width) / 2),
    y: Math.round((doc.height - inscribed.height) / 2),
    width: Math.floor(inscribed.width),
    height: Math.floor(inscribed.height),
  };
}

/** Scales the whole document, baking every layer to the new size. */
export function resampleDocument(doc: PixelDocument, width: number, height: number): void {
  const scaleX = width / doc.width;
  const scaleY = height / doc.height;

  for (const layer of doc.layers) {
    const scaled = createLayer({
      name: layer.name,
      width: Math.max(1, Math.round(layer.canvas.width * scaleX)),
      height: Math.max(1, Math.round(layer.canvas.height * scaleY)),
      opacity: layer.opacity,
      blendMode: layer.blendMode,
      visible: layer.visible,
      locked: layer.locked,
      type: layer.type,
    });
    scaled.ctx.imageSmoothingEnabled = true;
    scaled.ctx.imageSmoothingQuality = 'high';
    scaled.ctx.drawImage(layer.canvas, 0, 0, scaled.canvas.width, scaled.canvas.height);

    layer.canvas = scaled.canvas;
    layer.ctx = scaled.ctx;
    layer.x = Math.round(layer.x * scaleX);
    layer.y = Math.round(layer.y * scaleY);
  }

  doc.width = width;
  doc.height = height;
}
