import { SelectionMask } from './selection';
import type { Point, Rect } from './types';

/**
 * One point on a Bézier path.
 *
 * The handles are absolute document coordinates rather than offsets, because
 * everything that touches them — hit testing, dragging, rendering — works in
 * document space, and storing offsets would mean converting at every one of
 * those sites. A corner point simply has both handles sitting on the anchor.
 */
export interface PathAnchor {
  readonly x: number;
  readonly y: number;
  readonly inX: number;
  readonly inY: number;
  readonly outX: number;
  readonly outY: number;
}

export interface SubPath {
  readonly anchors: readonly PathAnchor[];
  readonly closed: boolean;
}

/**
 * A named path. Immutable, like the other document-level records: an edit
 * replaces the whole object, so history can hold one by reference and the
 * renderer can cache by identity.
 */
export interface VectorPath {
  readonly id: string;
  readonly name: string;
  readonly subpaths: readonly SubPath[];
}

let pathCounter = 0;

export function nextPathId(): string {
  pathCounter += 1;
  return `path-${pathCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createAnchor(x: number, y: number): PathAnchor {
  return { x, y, inX: x, inY: y, outX: x, outY: y };
}

export function emptyPath(name: string): VectorPath {
  return { id: nextPathId(), name, subpaths: [] };
}

/** True when both handles sit on the anchor, so the point is a corner. */
export function isCorner(anchor: PathAnchor): boolean {
  return anchor.inX === anchor.x && anchor.inY === anchor.y
    && anchor.outX === anchor.x && anchor.outY === anchor.y;
}

/**
 * True when the two handles are opposite and collinear through the anchor, so
 * the curve passes through without a kink.
 *
 * This is a different question from isCorner: a point where two curves meet at
 * an angle has two long handles that are not collinear, which is a corner even
 * though neither handle sits on the anchor. Curve fitting produces exactly
 * that, so anything drawing or counting corners needs this rather than a test
 * for zero-length handles.
 */
export function isSmooth(anchor: PathAnchor): boolean {
  const inX = anchor.inX - anchor.x;
  const inY = anchor.inY - anchor.y;
  const outX = anchor.outX - anchor.x;
  const outY = anchor.outY - anchor.y;

  const inLength = Math.hypot(inX, inY);
  const outLength = Math.hypot(outX, outY);
  if (inLength < 1e-6 || outLength < 1e-6) return false;

  // Opposite directions give a dot product of -1 once normalised.
  const alignment = (inX * outX + inY * outY) / (inLength * outLength);
  return alignment < -0.985;
}

/** Moves an anchor and its handles together. */
export function moveAnchor(anchor: PathAnchor, dx: number, dy: number): PathAnchor {
  return {
    x: anchor.x + dx, y: anchor.y + dy,
    inX: anchor.inX + dx, inY: anchor.inY + dy,
    outX: anchor.outX + dx, outY: anchor.outY + dy,
  };
}

/**
 * Points the out handle at a position and mirrors the in handle through the
 * anchor, which is what dragging while placing a point does.
 */
export function setSmoothHandles(anchor: PathAnchor, outX: number, outY: number): PathAnchor {
  return {
    ...anchor,
    outX, outY,
    inX: anchor.x - (outX - anchor.x),
    inY: anchor.y - (outY - anchor.y),
  };
}

export function toCorner(anchor: PathAnchor): PathAnchor {
  return createAnchor(anchor.x, anchor.y);
}

/** A smooth point whose handles lie along the neighbouring anchors. */
export function toSmooth(anchor: PathAnchor, previous: Point, next: Point): PathAnchor {
  const dx = next.x - previous.x;
  const dy = next.y - previous.y;
  const length = Math.hypot(dx, dy) || 1;
  const reach = length / 4;
  const ux = (dx / length) * reach;
  const uy = (dy / length) * reach;
  return {
    ...anchor,
    outX: anchor.x + ux, outY: anchor.y + uy,
    inX: anchor.x - ux, inY: anchor.y - uy,
  };
}

function appendSubPath(target: Path2D, sub: SubPath): void {
  const { anchors } = sub;
  if (anchors.length === 0) return;
  const first = anchors[0]!;
  target.moveTo(first.x, first.y);

  for (let i = 1; i < anchors.length; i += 1) {
    const from = anchors[i - 1]!;
    const to = anchors[i]!;
    target.bezierCurveTo(from.outX, from.outY, to.inX, to.inY, to.x, to.y);
  }

  if (sub.closed && anchors.length > 1) {
    const last = anchors[anchors.length - 1]!;
    target.bezierCurveTo(last.outX, last.outY, first.inX, first.inY, first.x, first.y);
    target.closePath();
  }
}

export function pathToPath2D(path: VectorPath): Path2D {
  const result = new Path2D();
  for (const sub of path.subpaths) appendSubPath(result, sub);
  return result;
}

/** One cubic segment's point at t, used for hit testing and splitting. */
function cubicAt(
  p0: Point, c0: Point, c1: Point, p1: Point, t: number,
): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * c0.x + c * c1.x + d * p1.x,
    y: a * p0.y + b * c0.y + c * c1.y + d * p1.y,
  };
}

export interface Segment {
  readonly subpath: number;
  readonly index: number;
  readonly from: PathAnchor;
  readonly to: PathAnchor;
}

/** Every drawable segment, including the closing one. */
export function segmentsOf(path: VectorPath): Segment[] {
  const segments: Segment[] = [];
  path.subpaths.forEach((sub, subpath) => {
    for (let i = 1; i < sub.anchors.length; i += 1) {
      segments.push({ subpath, index: i - 1, from: sub.anchors[i - 1]!, to: sub.anchors[i]! });
    }
    if (sub.closed && sub.anchors.length > 1) {
      segments.push({
        subpath,
        index: sub.anchors.length - 1,
        from: sub.anchors[sub.anchors.length - 1]!,
        to: sub.anchors[0]!,
      });
    }
  });
  return segments;
}

export type HitPart = 'anchor' | 'in' | 'out';

export interface AnchorHit {
  readonly subpath: number;
  readonly index: number;
  readonly part: HitPart;
}

/**
 * Finds an anchor or handle near a point. Handles win over anchors, because a
 * handle sitting on top of its anchor would otherwise be unreachable.
 */
export function hitAnchor(
  path: VectorPath,
  point: Point,
  tolerance: number,
  handlesFor: AnchorHit | null,
): AnchorHit | null {
  const near = (x: number, y: number): boolean =>
    Math.hypot(x - point.x, y - point.y) <= tolerance;

  if (handlesFor) {
    const sub = path.subpaths[handlesFor.subpath];
    const anchor = sub?.anchors[handlesFor.index];
    if (anchor && !isCorner(anchor)) {
      if (near(anchor.outX, anchor.outY)) return { ...handlesFor, part: 'out' };
      if (near(anchor.inX, anchor.inY)) return { ...handlesFor, part: 'in' };
    }
  }

  for (let s = 0; s < path.subpaths.length; s += 1) {
    const anchors = path.subpaths[s]!.anchors;
    for (let i = 0; i < anchors.length; i += 1) {
      const anchor = anchors[i]!;
      if (near(anchor.x, anchor.y)) return { subpath: s, index: i, part: 'anchor' };
    }
  }
  return null;
}

export interface SegmentHit {
  readonly subpath: number;
  readonly index: number;
  readonly t: number;
  readonly point: Point;
}

/** The closest point on any segment, for inserting an anchor mid-curve. */
export function hitSegment(
  path: VectorPath,
  point: Point,
  tolerance: number,
): SegmentHit | null {
  let best: SegmentHit | null = null;
  let bestDistance = tolerance;

  for (const segment of segmentsOf(path)) {
    const { from, to } = segment;
    const p0 = { x: from.x, y: from.y };
    const c0 = { x: from.outX, y: from.outY };
    const c1 = { x: to.inX, y: to.inY };
    const p1 = { x: to.x, y: to.y };

    const steps = 24;
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      const at = cubicAt(p0, c0, c1, p1, t);
      const distance = Math.hypot(at.x - point.x, at.y - point.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { subpath: segment.subpath, index: segment.index, t, point: at };
      }
    }
  }
  return best;
}

/** Splits a segment at t, so the curve keeps its shape. */
export function insertAnchor(path: VectorPath, hit: SegmentHit): VectorPath {
  const subpaths = path.subpaths.map((sub, s) => {
    if (s !== hit.subpath) return sub;

    const anchors = [...sub.anchors];
    const fromIndex = hit.index;
    const toIndex = (hit.index + 1) % anchors.length;
    const from = anchors[fromIndex]!;
    const to = anchors[toIndex]!;

    const t = hit.t;
    const lerp = (a: Point, b: Point): Point =>
      ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

    // De Casteljau: the split points are exactly the new handles.
    const p0 = { x: from.x, y: from.y };
    const c0 = { x: from.outX, y: from.outY };
    const c1 = { x: to.inX, y: to.inY };
    const p1 = { x: to.x, y: to.y };

    const a = lerp(p0, c0);
    const b = lerp(c0, c1);
    const c = lerp(c1, p1);
    const d = lerp(a, b);
    const e = lerp(b, c);
    const mid = lerp(d, e);

    anchors[fromIndex] = { ...from, outX: a.x, outY: a.y };
    anchors[toIndex] = { ...to, inX: c.x, inY: c.y };
    const inserted: PathAnchor = {
      x: mid.x, y: mid.y, inX: d.x, inY: d.y, outX: e.x, outY: e.y,
    };
    anchors.splice(fromIndex + 1, 0, inserted);
    return { ...sub, anchors };
  });

  return { ...path, subpaths };
}

export function removeAnchor(path: VectorPath, subpath: number, index: number): VectorPath {
  const subpaths: SubPath[] = [];
  path.subpaths.forEach((sub, s) => {
    if (s !== subpath) {
      subpaths.push(sub);
      return;
    }
    const anchors = sub.anchors.filter((_, i) => i !== index);
    if (anchors.length > 0) subpaths.push({ ...sub, anchors });
  });
  return { ...path, subpaths };
}

export function replaceAnchor(
  path: VectorPath, subpath: number, index: number, anchor: PathAnchor,
): VectorPath {
  const subpaths = path.subpaths.map((sub, s) => {
    if (s !== subpath) return sub;
    const anchors = sub.anchors.map((existing, i) => (i === index ? anchor : existing));
    return { ...sub, anchors };
  });
  return { ...path, subpaths };
}

export function anchorCount(path: VectorPath): number {
  return path.subpaths.reduce((total, sub) => total + sub.anchors.length, 0);
}

export function pathBounds(path: VectorPath): Rect | null {
  let minX = Infinity; let minY = Infinity;
  let maxX = -Infinity; let maxY = -Infinity;

  for (const segment of segmentsOf(path)) {
    const p0 = { x: segment.from.x, y: segment.from.y };
    const c0 = { x: segment.from.outX, y: segment.from.outY };
    const c1 = { x: segment.to.inX, y: segment.to.inY };
    const p1 = { x: segment.to.x, y: segment.to.y };
    for (let step = 0; step <= 16; step += 1) {
      const at = cubicAt(p0, c0, c1, p1, step / 16);
      minX = Math.min(minX, at.x); maxX = Math.max(maxX, at.x);
      minY = Math.min(minY, at.y); maxY = Math.max(maxY, at.y);
    }
  }

  // A path of isolated points still has bounds.
  for (const sub of path.subpaths) {
    for (const anchor of sub.anchors) {
      minX = Math.min(minX, anchor.x); maxX = Math.max(maxX, anchor.x);
      minY = Math.min(minY, anchor.y); maxY = Math.max(maxY, anchor.y);
    }
  }

  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Rasterises the path's filled area into a coverage mask.
 *
 * Only closed subpaths enclose anything, but Photoshop treats an open path as
 * though its ends were joined when you ask for a selection, so that is what
 * happens here too.
 */
export function pathToMask(
  path: VectorPath,
  width: number,
  height: number,
  antiAlias = true,
): SelectionMask {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const mask = new SelectionMask(width, height);
  if (!ctx) return mask;

  const filled = new Path2D();
  for (const sub of path.subpaths) {
    if (sub.anchors.length < 2) continue;
    appendSubPath(filled, { ...sub, closed: true });
  }

  ctx.fillStyle = '#ffffff';
  ctx.fill(filled, 'nonzero');

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  // Nothing in the 2D API turns anti-aliasing off, so a hard-edged selection
  // is made by thresholding the coverage the rasteriser produced.
  for (let i = 0; i < mask.data.length; i += 1) {
    const alpha = image.data[i * 4 + 3]!;
    mask.data[i] = antiAlias ? alpha : (alpha >= 128 ? 255 : 0);
  }
  return mask;
}

export function clonePath(path: VectorPath, name = path.name): VectorPath {
  return {
    id: nextPathId(),
    name,
    subpaths: path.subpaths.map((sub) => ({
      closed: sub.closed,
      anchors: sub.anchors.map((anchor) => ({ ...anchor })),
    })),
  };
}
