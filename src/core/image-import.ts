/** Decoding image files into canvases, with the failure cases spelled out. */

export const MAX_IMAGE_DIMENSION = 8000;

/** An import failure with something the user can actually act on. */
export class ImageImportError extends Error {
  readonly detail: string;

  constructor(message: string, detail: string) {
    super(message);
    this.name = 'ImageImportError';
    this.detail = detail;
  }
}

export interface DecodedImage {
  /** Layer name, taken from the source file. */
  readonly name: string;
  readonly source: CanvasImageSource;
  readonly width: number;
  readonly height: number;
}

export interface PreparedImage {
  readonly name: string;
  readonly canvas: HTMLCanvasElement;
}

const SUPPORTED_HINT = 'Try a PNG, JPEG, WebP, GIF or BMP file.';

export function fileBaseName(fileName: string): string {
  const trimmed = fileName.replace(/\.[^./\\]+$/, '');
  return trimmed.length > 0 ? trimmed : fileName;
}

/** Decodes a file or clipboard blob, or throws an ImageImportError. */
export async function decodeImage(blob: Blob, name: string): Promise<DecodedImage> {
  if (blob.type && !blob.type.startsWith('image/')) {
    throw new ImageImportError(
      `“${name}” is not an image.`,
      `PixelForge cannot open ${blob.type || 'this file type'}. ${SUPPORTED_HINT}`,
    );
  }
  if (blob.size === 0) {
    throw new ImageImportError(`“${name}” is empty.`, 'The file contains no data.');
  }

  try {
    const bitmap = await createImageBitmap(blob);
    if (bitmap.width === 0 || bitmap.height === 0) {
      throw new ImageImportError(
        `“${name}” has no picture in it.`,
        'The image reports a size of zero. It may be an unsupported vector file.',
      );
    }
    return { name, source: bitmap, width: bitmap.width, height: bitmap.height };
  } catch (error) {
    if (error instanceof ImageImportError) throw error;
    return decodeViaElement(blob, name);
  }
}

/** Fallback for formats createImageBitmap refuses, such as SVG in some browsers. */
async function decodeViaElement(blob: Blob, name: string): Promise<DecodedImage> {
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.src = url;

  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new ImageImportError(
      `“${name}” could not be opened.`,
      `The file looks damaged or is in a format this browser cannot decode. ${SUPPORTED_HINT}`,
    );
  }

  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (width === 0 || height === 0) {
    URL.revokeObjectURL(url);
    throw new ImageImportError(
      `“${name}” has no intrinsic size.`,
      'Vector files without a width and height cannot be placed. Export it as a PNG first.',
    );
  }

  // The element keeps the URL alive until the caller has drawn from it.
  return { name, source: image, width, height };
}

export function exceedsLimit(image: DecodedImage): boolean {
  return Math.max(image.width, image.height) > MAX_IMAGE_DIMENSION;
}

/** Draws a decoded image into a canvas, optionally scaled down to the limit. */
export function prepareImage(image: DecodedImage, downscale: boolean): PreparedImage {
  const longest = Math.max(image.width, image.height);
  const scale = downscale && longest > MAX_IMAGE_DIMENSION ? MAX_IMAGE_DIMENSION / longest : 1;

  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ImageImportError('Could not prepare the image.', 'The browser refused a 2D canvas context.');

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image.source, 0, 0, width, height);

  releaseSource(image.source);
  return { name: image.name, canvas };
}

/** Frees whichever decode path produced the source. */
export function releaseSource(source: CanvasImageSource): void {
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) {
    source.close();
  } else if (source instanceof HTMLImageElement && source.src.startsWith('blob:')) {
    URL.revokeObjectURL(source.src);
  }
}
