import type { Rect } from './types';

export const TILE_SIZE = 256;

/**
 * Tracks which 256x256 tiles of the document need recompositing.
 *
 * The compositor used to redraw everything whenever anything changed, which
 * is fine at 1200x800 and hopeless at 6000x4000. A brush dab touches one or
 * two tiles, so recompositing walks those instead of twenty-four million
 * pixels.
 */
export class TileGrid {
  private columns = 0;
  private rows = 0;
  private dirty = new Set<number>();
  private everythingDirty = true;

  resize(width: number, height: number): void {
    const columns = Math.max(1, Math.ceil(width / TILE_SIZE));
    const rows = Math.max(1, Math.ceil(height / TILE_SIZE));
    if (columns === this.columns && rows === this.rows) return;

    this.columns = columns;
    this.rows = rows;
    this.markAll();
  }

  markAll(): void {
    this.everythingDirty = true;
    this.dirty.clear();
  }

  clean(): void {
    this.everythingDirty = false;
    this.dirty.clear();
  }

  get isEverythingDirty(): boolean {
    return this.everythingDirty;
  }

  get dirtyCount(): number {
    return this.everythingDirty ? this.columns * this.rows : this.dirty.size;
  }

  get tileCount(): number {
    return this.columns * this.rows;
  }

  /** Marks every tile the rectangle touches. */
  markRect(rect: Rect): void {
    if (this.everythingDirty) return;

    const left = Math.max(0, Math.floor(rect.x / TILE_SIZE));
    const top = Math.max(0, Math.floor(rect.y / TILE_SIZE));
    const right = Math.min(this.columns - 1, Math.floor((rect.x + rect.width - 1) / TILE_SIZE));
    const bottom = Math.min(this.rows - 1, Math.floor((rect.y + rect.height - 1) / TILE_SIZE));

    for (let row = top; row <= bottom; row++) {
      for (let column = left; column <= right; column++) {
        this.dirty.add(row * this.columns + column);
      }
    }
  }

  /**
   * The region to recomposite: the union of the dirty tiles, or null when
   * nothing is dirty. A union rather than a list of tiles because one clipped
   * pass over a slightly larger area beats many small ones.
   */
  dirtyRegion(width: number, height: number): Rect | null {
    if (this.everythingDirty) return { x: 0, y: 0, width, height };
    if (this.dirty.size === 0) return null;

    let left = this.columns;
    let top = this.rows;
    let right = -1;
    let bottom = -1;

    for (const index of this.dirty) {
      const column = index % this.columns;
      const row = (index - column) / this.columns;
      if (column < left) left = column;
      if (column > right) right = column;
      if (row < top) top = row;
      if (row > bottom) bottom = row;
    }

    const x = left * TILE_SIZE;
    const y = top * TILE_SIZE;
    return {
      x,
      y,
      width: Math.min(width - x, (right - left + 1) * TILE_SIZE),
      height: Math.min(height - y, (bottom - top + 1) * TILE_SIZE),
    };
  }
}
