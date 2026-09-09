import type { SelectionMask } from './selection';

/** Coverage at or above this counts as inside when tracing the outline. */
export const CONTOUR_THRESHOLD = 128;

type Corner = number;

/**
 * Traces the boundary of a mask as closed loops in document coordinates,
 * following pixel edges at the 128 threshold.
 *
 * Walking pixel edges rather than interpolating a smooth isoline puts the ants
 * exactly on the pixel boundary, and it traces the true compound shape —
 * holes and separate islands included — rather than a bounding box.
 */
export function traceSelectionOutline(mask: SelectionMask): Path2D {
  const { width, height, data } = mask;
  /** Corners form a (width+1) x (height+1) lattice. */
  const stride = width + 1;

  const inside = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && data[y * width + x]! >= CONTOUR_THRESHOLD;

  // Directed unit edges, oriented so the selected area stays on one side.
  const outgoing = new Map<Corner, Corner[]>();
  const addEdge = (ax: number, ay: number, bx: number, by: number): void => {
    const from = ay * stride + ax;
    const to = by * stride + bx;
    const list = outgoing.get(from);
    if (list) list.push(to);
    else outgoing.set(from, [to]);
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!inside(x, y)) continue;
      if (!inside(x, y - 1)) addEdge(x, y, x + 1, y);
      if (!inside(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
      if (!inside(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
      if (!inside(x - 1, y)) addEdge(x, y + 1, x, y);
    }
  }

  const path = new Path2D();
  for (const start of [...outgoing.keys()]) {
    while ((outgoing.get(start)?.length ?? 0) > 0) {
      const loop = walkLoop(outgoing, start);
      if (loop.length > 2) emitLoop(path, loop, stride);
    }
  }
  return path;
}

/** Follows edges from `start` until the loop closes, consuming them. */
function walkLoop(outgoing: Map<Corner, Corner[]>, start: Corner): Corner[] {
  const loop: Corner[] = [];
  let current = start;

  for (;;) {
    const list = outgoing.get(current);
    if (!list || list.length === 0) break;

    const next = list.pop()!;
    if (list.length === 0) outgoing.delete(current);

    loop.push(current);
    current = next;
    if (current === start) break;
  }
  return loop;
}

/** Writes a loop into the path, dropping points that sit on a straight run. */
function emitLoop(path: Path2D, loop: readonly Corner[], stride: number): void {
  const points = loop.map((key): [number, number] => [key % stride, Math.floor(key / stride)]);
  const kept: [number, number][] = [];

  for (let i = 0; i < points.length; i++) {
    const previous = points[(i - 1 + points.length) % points.length]!;
    const current = points[i]!;
    const next = points[(i + 1) % points.length]!;

    const collinear =
      (current[0] - previous[0]) * (next[1] - current[1]) ===
      (current[1] - previous[1]) * (next[0] - current[0]);
    if (!collinear) kept.push(current);
  }

  const outline = kept.length > 2 ? kept : points;
  const first = outline[0];
  if (!first) return;

  path.moveTo(first[0], first[1]);
  for (let i = 1; i < outline.length; i++) path.lineTo(outline[i]![0], outline[i]![1]);
  path.closePath();
}
