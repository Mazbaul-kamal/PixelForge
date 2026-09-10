import type { Point } from './types';

/**
 * Row-major 3x3 homogeneous matrix.
 *
 * Every transform in the free transform tool — scale, rotate, skew, distort
 * and perspective — is one of these, so they all share a single code path
 * instead of each having its own special case.
 */
export type Matrix3 = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
];

export const IDENTITY: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function multiply(a: Matrix3, b: Matrix3): Matrix3 {
  const out = new Array<number>(9);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out[row * 3 + col] =
        a[row * 3]! * b[col]! +
        a[row * 3 + 1]! * b[3 + col]! +
        a[row * 3 + 2]! * b[6 + col]!;
    }
  }
  return out as unknown as Matrix3;
}

export function apply(m: Matrix3, x: number, y: number): Point {
  const w = m[6]! * x + m[7]! * y + m[8]!;
  const divisor = Math.abs(w) < 1e-12 ? 1e-12 : w;
  return {
    x: (m[0]! * x + m[1]! * y + m[2]!) / divisor,
    y: (m[3]! * x + m[4]! * y + m[5]!) / divisor,
  };
}

export function translate(tx: number, ty: number): Matrix3 {
  return [1, 0, tx, 0, 1, ty, 0, 0, 1];
}

export function scale(sx: number, sy: number): Matrix3 {
  return [sx, 0, 0, 0, sy, 0, 0, 0, 1];
}

export function rotate(angle: number): Matrix3 {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [cos, -sin, 0, sin, cos, 0, 0, 0, 1];
}

export function skew(kx: number, ky: number): Matrix3 {
  return [1, Math.tan(kx), 0, Math.tan(ky), 1, 0, 0, 0, 1];
}

/** True when the matrix has no projective component, so it is affine. */
export function isAffine(m: Matrix3): boolean {
  return Math.abs(m[6]!) < 1e-9 && Math.abs(m[7]!) < 1e-9;
}

export function invert(m: Matrix3): Matrix3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e! * i! - f! * h!;
  const B = f! * g! - d! * i!;
  const C = d! * h! - e! * g!;
  const determinant = a! * A + b! * B + c! * C;
  if (Math.abs(determinant) < 1e-12) return null;

  const inv = 1 / determinant;
  return [
    A * inv, (c! * h! - b! * i!) * inv, (b! * f! - c! * e!) * inv,
    B * inv, (a! * i! - c! * g!) * inv, (c! * d! - a! * f!) * inv,
    C * inv, (b! * g! - a! * h!) * inv, (a! * e! - b! * d!) * inv,
  ];
}

/**
 * The projective transform taking four source points to four destination
 * points. Solving this directly is what lets a corner be dragged anywhere —
 * distort and perspective are the same operation with different constraints.
 */
export function fromQuad(source: readonly Point[], destination: readonly Point[]): Matrix3 | null {
  if (source.length < 4 || destination.length < 4) return null;

  // Eight unknowns: a b c d e f g h, with the final entry pinned to 1.
  const rows: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const s = source[i]!;
    const d = destination[i]!;
    rows.push([s.x, s.y, 1, 0, 0, 0, -s.x * d.x, -s.y * d.x, d.x]);
    rows.push([0, 0, 0, s.x, s.y, 1, -s.x * d.y, -s.y * d.y, d.y]);
  }

  const solution = solve(rows, 8);
  if (!solution) return null;

  return [
    solution[0]!, solution[1]!, solution[2]!,
    solution[3]!, solution[4]!, solution[5]!,
    solution[6]!, solution[7]!, 1,
  ];
}

/** Gaussian elimination with partial pivoting. */
function solve(rows: number[][], size: number): number[] | null {
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++) {
      if (Math.abs(rows[row]![column]!) > Math.abs(rows[pivot]![column]!)) pivot = row;
    }
    if (Math.abs(rows[pivot]![column]!) < 1e-12) return null;

    const temp = rows[column]!;
    rows[column] = rows[pivot]!;
    rows[pivot] = temp;

    const lead = rows[column]![column]!;
    for (let k = column; k <= size; k++) rows[column]![k] = rows[column]![k]! / lead;

    for (let row = 0; row < size; row++) {
      if (row === column) continue;
      const factor = rows[row]![column]!;
      if (factor === 0) continue;
      for (let k = column; k <= size; k++) {
        rows[row]![k] = rows[row]![k]! - factor * rows[column]![k]!;
      }
    }
  }
  return rows.map((row) => row[size]!);
}

/** The four corners of a rectangle, clockwise from the top left. */
export function rectCorners(x: number, y: number, width: number, height: number): Point[] {
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}
