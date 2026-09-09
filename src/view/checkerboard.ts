/**
 * The transparency checkerboard. It exists only on the on-screen view; drawing
 * it into the composite would make blend modes composite against the pattern.
 */
export const CHECKER_CELL_CSS_PX = 8;

/** Builds a two-square tile at device resolution so the squares stay crisp. */
export function createCheckerPattern(
  ctx: CanvasRenderingContext2D,
  cellDevicePx: number,
  colourA: string,
  colourB: string,
): CanvasPattern {
  const cell = Math.max(1, Math.round(cellDevicePx));
  const tile = document.createElement('canvas');
  tile.width = cell * 2;
  tile.height = cell * 2;

  const tileCtx = tile.getContext('2d');
  if (!tileCtx) throw new Error('Could not acquire a 2D context for the checkerboard tile.');

  tileCtx.fillStyle = colourA;
  tileCtx.fillRect(0, 0, cell * 2, cell * 2);
  tileCtx.fillStyle = colourB;
  tileCtx.fillRect(0, 0, cell, cell);
  tileCtx.fillRect(cell, cell, cell, cell);

  const pattern = ctx.createPattern(tile, 'repeat');
  if (!pattern) throw new Error('Could not create the checkerboard pattern.');
  return pattern;
}
