import type { Point } from './types';

/** One cubic segment: end points and the two control points between them. */
export interface Cubic {
  readonly p0: Point;
  readonly c1: Point;
  readonly c2: Point;
  readonly p3: Point;
}

const subtract = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a: Point, k: number): Point => ({ x: a.x * k, y: a.y * k });
const dot = (a: Point, b: Point): number => a.x * b.x + a.y * b.y;

function normalise(v: Point): Point {
  const length = Math.hypot(v.x, v.y);
  return length === 0 ? { x: 0, y: 0 } : { x: v.x / length, y: v.y / length };
}

function bezierAt(curve: Cubic, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * curve.p0.x + b * curve.c1.x + c * curve.c2.x + d * curve.p3.x,
    y: a * curve.p0.y + b * curve.c1.y + c * curve.c2.y + d * curve.p3.y,
  };
}

/** First and second derivatives, for the Newton step below. */
function bezierPrime(curve: Cubic, t: number): Point {
  const u = 1 - t;
  return add(add(
    scale(subtract(curve.c1, curve.p0), 3 * u * u),
    scale(subtract(curve.c2, curve.c1), 6 * u * t),
  ), scale(subtract(curve.p3, curve.c2), 3 * t * t));
}

function bezierPrimePrime(curve: Cubic, t: number): Point {
  const u = 1 - t;
  return add(
    scale(add(subtract(curve.c2, scale(curve.c1, 2)), curve.p0), 6 * u),
    scale(add(subtract(curve.p3, scale(curve.c2, 2)), curve.c1), 6 * t),
  );
}

/** Chord-length parameterisation: each point gets the t its distance implies. */
function chordLengths(points: readonly Point[]): number[] {
  const u = [0];
  for (let i = 1; i < points.length; i += 1) {
    u.push(u[i - 1]! + Math.hypot(
      points[i]!.x - points[i - 1]!.x,
      points[i]!.y - points[i - 1]!.y,
    ));
  }
  const total = u[u.length - 1]!;
  return total === 0 ? u.map(() => 0) : u.map((value) => value / total);
}

/**
 * The least-squares cubic through the points with the given end tangents.
 *
 * This is the heart of Schneider's method: with both end points and both
 * tangent directions fixed, the only unknowns are how far along each tangent
 * the control points sit, and that is a 2x2 system.
 */
function generateBezier(
  points: readonly Point[], u: readonly number[], left: Point, right: Point,
): Cubic {
  const first = points[0]!;
  const last = points[points.length - 1]!;

  let c00 = 0; let c01 = 0; let c11 = 0; let x0 = 0; let x1 = 0;

  for (let i = 0; i < points.length; i += 1) {
    const t = u[i]!;
    const ut = 1 - t;
    const b0 = ut * ut * ut;
    const b1 = 3 * ut * ut * t;
    const b2 = 3 * ut * t * t;
    const b3 = t * t * t;

    const a0 = scale(left, b1);
    const a1 = scale(right, b2);

    c00 += dot(a0, a0);
    c01 += dot(a0, a1);
    c11 += dot(a1, a1);

    const tmp = subtract(points[i]!, add(scale(first, b0 + b1), scale(last, b2 + b3)));
    x0 += dot(a0, tmp);
    x1 += dot(a1, tmp);
  }

  const determinant = c00 * c11 - c01 * c01;
  let alphaLeft: number;
  let alphaRight: number;

  if (Math.abs(determinant) < 1e-12) {
    // Degenerate system, so fall back to the standard thirds.
    const separation = Math.hypot(last.x - first.x, last.y - first.y) / 3;
    alphaLeft = separation;
    alphaRight = separation;
  } else {
    alphaLeft = (x0 * c11 - x1 * c01) / determinant;
    alphaRight = (c00 * x1 - c01 * x0) / determinant;
  }

  // A negative or vanishing handle would fold the curve back on itself.
  const separation = Math.hypot(last.x - first.x, last.y - first.y);
  if (alphaLeft < 1e-6 || alphaRight < 1e-6) {
    alphaLeft = separation / 3;
    alphaRight = separation / 3;
  }

  return {
    p0: first,
    c1: add(first, scale(left, alphaLeft)),
    c2: add(last, scale(right, alphaRight)),
    p3: last,
  };
}

/** One Newton-Raphson step toward the t whose point is nearest to `point`. */
function newtonRaphson(curve: Cubic, point: Point, t: number): number {
  const d = subtract(bezierAt(curve, t), point);
  const d1 = bezierPrime(curve, t);
  const d2 = bezierPrimePrime(curve, t);
  const numerator = dot(d, d1);
  const denominator = dot(d1, d1) + dot(d, d2);
  return denominator === 0 ? t : t - numerator / denominator;
}

function maxError(
  points: readonly Point[], curve: Cubic, u: readonly number[],
): { error: number; index: number } {
  let error = 0;
  let index = Math.floor(points.length / 2);

  for (let i = 1; i < points.length - 1; i += 1) {
    const at = bezierAt(curve, u[i]!);
    const distance = (at.x - points[i]!.x) ** 2 + (at.y - points[i]!.y) ** 2;
    if (distance >= error) {
      error = distance;
      index = i;
    }
  }
  return { error: Math.sqrt(error), index };
}

function fitCubic(
  points: readonly Point[], left: Point, right: Point, tolerance: number, depth: number,
): Cubic[] {
  if (points.length < 2) return [];

  const first = points[0]!;
  const last = points[points.length - 1]!;

  if (points.length === 2) {
    const separation = Math.hypot(last.x - first.x, last.y - first.y) / 3;
    return [{
      p0: first,
      c1: add(first, scale(left, separation)),
      c2: add(last, scale(right, separation)),
      p3: last,
    }];
  }

  let u = chordLengths(points);
  let curve = generateBezier(points, u, left, right);
  let { error, index } = maxError(points, curve, u);
  if (error < tolerance) return [curve];

  // Close enough to be worth refining where each point sits on the curve.
  if (error < tolerance * tolerance) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      u = u.map((t, i) => newtonRaphson(curve, points[i]!, t));
      curve = generateBezier(points, u, left, right);
      const next = maxError(points, curve, u);
      error = next.error;
      index = next.index;
      if (error < tolerance) return [curve];
    }
  }

  // Still too far out, so split at the worst point and fit each half.
  // The depth guard keeps a pathological outline from recursing forever.
  if (depth > 24 || index <= 0 || index >= points.length - 1) return [curve];

  const centre = normalise(subtract(points[index - 1]!, points[index + 1]!));
  return [
    ...fitCubic(points.slice(0, index + 1), left, centre, tolerance, depth + 1),
    ...fitCubic(points.slice(index), scale(centre, -1), right, tolerance, depth + 1),
  ];
}

/** A tangent estimated over a window, so a pixel staircase does not dominate. */
function tangentAt(points: readonly Point[], index: number, span: number, forward: boolean): Point {
  const other = forward
    ? Math.min(points.length - 1, index + span)
    : Math.max(0, index - span);
  const v = forward
    ? subtract(points[other]!, points[index]!)
    : subtract(points[other]!, points[index]!);
  return normalise(v);
}

/**
 * Fits a chain of cubics to an open run of points.
 *
 * `tolerance` is the furthest a fitted curve may sit from the input, in
 * document pixels.
 */
export function fitOpenCurve(points: readonly Point[], tolerance: number): Cubic[] {
  if (points.length < 2) return [];
  const span = Math.min(4, points.length - 1);
  const left = tangentAt(points, 0, span, true);
  const right = tangentAt(points, points.length - 1, span, false);
  return fitCubic(points, left, right, tolerance, 0);
}

/**
 * Where the outline turns sharply enough that a corner must be kept.
 *
 * The angle is measured across a window rather than between neighbours,
 * because a mask boundary turns ninety degrees at every single pixel step and
 * measuring locally would call all of it corners.
 */
export function findCorners(
  points: readonly Point[], closed: boolean, window: number, threshold: number,
): number[] {
  const corners: number[] = [];
  const count = points.length;
  if (count < window * 2 + 1) return corners;

  const cosLimit = Math.cos((180 - threshold) * Math.PI / 180);

  for (let i = 0; i < count; i += 1) {
    if (!closed && (i < window || i >= count - window)) continue;

    const back = points[(i - window + count) % count]!;
    const forward = points[(i + window) % count]!;
    const a = normalise(subtract(back, points[i]!));
    const b = normalise(subtract(forward, points[i]!));
    // dot is cos of the angle at the point; a straight run gives -1.
    if (dot(a, b) > cosLimit) corners.push(i);
  }

  // Only the sharpest point of each run of candidates is a real corner.
  const kept: number[] = [];
  for (let i = 0; i < corners.length; i += 1) {
    const at = corners[i]!;
    const previous = kept[kept.length - 1];
    if (previous !== undefined && at - previous < window) continue;
    kept.push(at);
  }
  return kept;
}

/**
 * Light smoothing of a pixel-boundary outline.
 *
 * A traced mask edge is a staircase of unit steps. Fitting straight to it
 * gives curves that chase the steps; averaging over a tiny window first gives
 * the fitter the shape a person sees without moving the boundary meaningfully.
 */
export function smoothOutline(points: readonly Point[], closed: boolean): Point[] {
  const count = points.length;
  if (count < 5) return [...points];

  const out: Point[] = [];
  for (let i = 0; i < count; i += 1) {
    let sumX = 0;
    let sumY = 0;
    let total = 0;
    for (let k = -1; k <= 1; k += 1) {
      const index = closed
        ? (i + k + count) % count
        : Math.min(count - 1, Math.max(0, i + k));
      sumX += points[index]!.x;
      sumY += points[index]!.y;
      total += 1;
    }
    out.push({ x: sumX / total, y: sumY / total });
  }
  return out;
}
