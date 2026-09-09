import { drawLayers } from './compositor';
import type { PixelDocument } from './document';

export type ExportFormat = 'png' | 'jpeg' | 'webp';

export interface ExportOptions {
  format: ExportFormat;
  /** 0..1, used by JPEG and WebP. */
  quality: number;
  /** 0.5, 1 or 2. */
  scale: number;
}

const MIME: Record<ExportFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

const EXTENSION: Record<ExportFormat, string> = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
};

export function exportFilename(documentName: string, format: ExportFormat): string {
  const base = documentName.trim().replace(/[\\/:*?"<>|]+/g, '-') || 'Untitled';
  return `${base}.${EXTENSION[format]}`;
}

/**
 * Flattens the document into a blob.
 *
 * JPEG has no alpha channel, so a white matte is painted first: without it
 * transparent pixels come out black rather than white.
 */
export async function renderExport(doc: PixelDocument, options: ExportOptions): Promise<Blob> {
  const width = Math.max(1, Math.round(doc.width * options.scale));
  const height = Math.max(1, Math.round(doc.height * options.scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not acquire a 2D context for the export.');

  if (options.format === 'jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }

  ctx.setTransform(options.scale, 0, 0, options.scale, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  drawLayers(ctx, doc.layers);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // toBlob, never toDataURL: a large export would otherwise build a string
  // tens of megabytes long before it could be saved.
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, MIME[options.format], options.quality);
  });

  if (!blob) {
    throw new Error(`This browser could not encode a ${options.format.toUpperCase()} file.`);
  }
  return blob;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next tick so the download has definitely started.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
