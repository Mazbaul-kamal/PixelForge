import type { PixelDocument } from './document';
import type { SelectionMask } from './selection';

export interface PatternDefinition {
  readonly id: string;
  readonly name: string;
  readonly canvas: HTMLCanvasElement;
}

function tile(
  id: string,
  name: string,
  size: number,
  draw: (ctx: CanvasRenderingContext2D, size: number) => void,
): PatternDefinition {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) draw(ctx, size);
  return { id, name, canvas };
}

/** A few tileable patterns, generated rather than shipped as image files. */
export function builtInPatterns(): PatternDefinition[] {
  return [
    tile('checker', 'Checkerboard', 16, (ctx, size) => {
      const half = size / 2;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#c8c8c8';
      ctx.fillRect(0, 0, half, half);
      ctx.fillRect(half, half, half, half);
    }),
    tile('stripes', 'Diagonal stripes', 16, (ctx, size) => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size, size);
      ctx.strokeStyle = '#9aa7b4';
      ctx.lineWidth = 4;
      // Drawn three times so the diagonal wraps cleanly at the tile edges.
      for (const offset of [-size, 0, size]) {
        ctx.beginPath();
        ctx.moveTo(offset - 2, size + 2);
        ctx.lineTo(offset + size + 2, -2);
        ctx.stroke();
      }
    }),
    tile('dots', 'Dots', 16, (ctx, size) => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#7f8c99';
      for (const [cx, cy] of [[size / 4, size / 4], [(size * 3) / 4, (size * 3) / 4]]) {
        ctx.beginPath();
        ctx.arc(cx!, cy!, size / 8, 0, Math.PI * 2);
        ctx.fill();
      }
    }),
    tile('grid', 'Grid', 16, (ctx, size) => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size, size);
      ctx.strokeStyle = '#b6bec6';
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, size - 1, size - 1);
    }),
  ];
}

/**
 * Captures the current selection from the composite as a repeating tile.
 * The selection's bounding box becomes the tile, masked to its coverage.
 */
export function patternFromSelection(
  doc: PixelDocument,
  selection: SelectionMask,
  source: HTMLCanvasElement,
): PatternDefinition | null {
  const bounds = selection.bounds();
  if (bounds.width === 0 || bounds.height === 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = bounds.width;
  canvas.height = bounds.height;

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.drawImage(source, -bounds.x, -bounds.y);
  selection.applyClip(ctx, bounds.x, bounds.y);
  void doc;

  return { id: `custom-${Date.now()}`, name: 'From selection', canvas };
}
