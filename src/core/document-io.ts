import type { PixelDocument } from './document';
import type { History } from './history';
import { createLayer } from './layer';
import type { PreparedImage } from './image-import';

export type BackgroundKind = 'white' | 'transparent' | 'custom';

export interface NewDocumentOptions {
  width: number;
  height: number;
  background: BackgroundKind;
  /** Used when background is 'custom'. */
  colour?: string;
  name?: string;
}

/**
 * Rebuilds the document in place. Everything holds a reference to the same
 * PixelDocument, so a new document is a reset rather than a new object.
 */
export function resetDocument(
  doc: PixelDocument,
  history: History,
  options: NewDocumentOptions,
): void {
  doc.width = Math.max(1, Math.round(options.width));
  doc.height = Math.max(1, Math.round(options.height));
  doc.layers.length = 0;
  doc.activeLayerId = null;
  doc.selection = null;
  doc.name = options.name ?? 'Untitled';

  const fill =
    options.background === 'white'
      ? '#ffffff'
      : options.background === 'custom'
        ? (options.colour ?? '#ffffff')
        : undefined;

  const layer = createLayer({
    name: 'Background',
    width: doc.width,
    height: doc.height,
    ...(fill ? { fill } : {}),
  });
  doc.addLayer(layer);
  doc.setActiveLayer(layer.id);

  history.clear('New Document');
  doc.pristine = true;
}

export interface PlaceResult {
  readonly layerIds: string[];
  /** True when the document was resized to match the first image. */
  readonly replacedDocument: boolean;
}

/**
 * Places prepared images as layers.
 *
 * Into a pristine document the first image REPLACES the document: the canvas
 * is resized to the image and history is cleared, because an untouched boot
 * document is not something anyone wants to undo back to. Any further images,
 * and every image into a document that has been worked on, are centred as new
 * layers inside one history entry.
 */
export function placeImages(
  doc: PixelDocument,
  history: History,
  images: readonly PreparedImage[],
): PlaceResult {
  if (images.length === 0) return { layerIds: [], replacedDocument: false };

  const layerIds: string[] = [];
  let replacedDocument = false;
  let rest = images;

  const first = images[0];
  if (doc.pristine && first) {
    doc.width = first.canvas.width;
    doc.height = first.canvas.height;
    doc.layers.length = 0;
    doc.activeLayerId = null;
    doc.name = first.name;

    const layer = createLayer({
      name: first.name,
      width: first.canvas.width,
      height: first.canvas.height,
    });
    layer.ctx.drawImage(first.canvas, 0, 0);
    doc.addLayer(layer);
    doc.setActiveLayer(layer.id);

    history.clear(`Open ${first.name}`);
    doc.pristine = false;
    layerIds.push(layer.id);
    replacedDocument = true;
    rest = images.slice(1);
  }

  if (rest.length > 0) {
    const label = rest.length > 1 ? `Place ${rest.length} Images` : `Place ${rest[0]?.name ?? 'Image'}`;
    history.transaction(label, () => {
      for (const image of rest) {
        const layer = createLayer({
          name: image.name,
          width: image.canvas.width,
          height: image.canvas.height,
          x: Math.round((doc.width - image.canvas.width) / 2),
          y: Math.round((doc.height - image.canvas.height) / 2),
        });
        layer.ctx.drawImage(image.canvas, 0, 0);
        doc.addLayer(layer);
        doc.setActiveLayer(layer.id);
        layerIds.push(layer.id);
      }
    });
  }

  return { layerIds, replacedDocument };
}
