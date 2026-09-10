import { apply, isAffine } from './matrix3';
import type { Matrix3 } from './matrix3';
import type { Point } from './types';

/** Subdivisions per axis when a transform has a projective component. */
export const PERSPECTIVE_GRID = 20;

/**
 * Triangles are expanded very slightly about their centroid before being
 * drawn. Adjacent clipped triangles otherwise leave hairline gaps where their
 * antialiased edges meet, which reads as visible seams.
 */
const SEAM_OVERLAP_PX = 0.5;

export interface TransformResult {
  readonly canvas: HTMLCanvasElement;
  /** Where the rendered bitmap sits in document space. */
  readonly x: number;
  readonly y: number;
}

/** Bounding box of a source rectangle after the transform. */
export function transformedBounds(
  matrix: Matrix3,
  width: number,
  height: number,
): { x: number; y: number; width: number; height: number } {
  const corners = [
    apply(matrix, 0, 0),
    apply(matrix, width, 0),
    apply(matrix, width, height),
    apply(matrix, 0, height),
  ];

  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const left = Math.floor(Math.min(...xs));
  const top = Math.floor(Math.min(...ys));
  const right = Math.ceil(Math.max(...xs));
  const bottom = Math.ceil(Math.max(...ys));

  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

function expand(a: Point, b: Point, c: Point): [Point, Point, Point] {
  const cx = (a.x + b.x + c.x) / 3;
  const cy = (a.y + b.y + c.y) / 3;

  const push = (p: Point): Point => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) return p;
    const k = (length + SEAM_OVERLAP_PX) / length;
    return { x: cx + dx * k, y: cy + dy * k };
  };

  return [push(a), push(b), push(c)];
}

/**
 * Draws one source triangle onto the destination with the affine transform
 * that maps it there, clipped to the destination triangle.
 */
function drawTriangle(
  ctx: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  s: [Point, Point, Point],
  d: [Point, Point, Point],
): void {
  const [p0, p1, p2] = expand(d[0], d[1], d[2]);

  const denominator =
    s[0].x * (s[1].y - s[2].y) + s[1].x * (s[2].y - s[0].y) + s[2].x * (s[0].y - s[1].y);
  if (Math.abs(denominator) < 1e-9) return;

  const a = (d[0].x * (s[1].y - s[2].y) + d[1].x * (s[2].y - s[0].y) + d[2].x * (s[0].y - s[1].y)) / denominator;
  const b = (d[0].y * (s[1].y - s[2].y) + d[1].y * (s[2].y - s[0].y) + d[2].y * (s[0].y - s[1].y)) / denominator;
  const c = (d[0].x * (s[2].x - s[1].x) + d[1].x * (s[0].x - s[2].x) + d[2].x * (s[1].x - s[0].x)) / denominator;
  const e = (d[0].y * (s[2].x - s[1].x) + d[1].y * (s[0].x - s[2].x) + d[2].y * (s[1].x - s[0].x)) / denominator;
  const f = (
    d[0].x * (s[1].x * s[2].y - s[2].x * s[1].y) +
    d[1].x * (s[2].x * s[0].y - s[0].x * s[2].y) +
    d[2].x * (s[0].x * s[1].y - s[1].x * s[0].y)
  ) / denominator;
  const g = (
    d[0].y * (s[1].x * s[2].y - s[2].x * s[1].y) +
    d[1].y * (s[2].x * s[0].y - s[0].x * s[2].y) +
    d[2].y * (s[0].x * s[1].y - s[1].x * s[0].y)
  ) / denominator;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y);
  ctx.lineTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, e, f, g);
  ctx.drawImage(source, 0, 0);
  ctx.restore();
}

/**
 * Renders a bitmap through a 3x3 matrix.
 *
 * Canvas transforms are affine only, so a matrix with a projective component
 * is drawn by subdividing the source into a grid of triangles and giving each
 * its own affine approximation.
 */
export function renderTransform(
  source: HTMLCanvasElement,
  matrix: Matrix3,
  options: { quality?: 'low' | 'high' } = {},
): TransformResult {
  const bounds = transformedBounds(matrix, source.width, source.height);

  const canvas = document.createElement('canvas');
  canvas.width = bounds.width;
  canvas.height = bounds.height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not acquire a 2D context for the transform.');

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = options.quality ?? 'high';
  ctx.translate(-bounds.x, -bounds.y);

  if (isAffine(matrix)) {
    ctx.transform(matrix[0]!, matrix[3]!, matrix[1]!, matrix[4]!, matrix[2]!, matrix[5]!);
    ctx.drawImage(source, 0, 0);
    return { canvas, x: bounds.x, y: bounds.y };
  }

  const stepX = source.width / PERSPECTIVE_GRID;
  const stepY = source.height / PERSPECTIVE_GRID;

  for (let row = 0; row < PERSPECTIVE_GRID; row++) {
    for (let column = 0; column < PERSPECTIVE_GRID; column++) {
      const x0 = column * stepX;
      const y0 = row * stepY;
      const x1 = x0 + stepX;
      const y1 = y0 + stepY;

      const corners: Point[] = [
        { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
      ];
      const mapped = corners.map((p) => apply(matrix, p.x, p.y));

      drawTriangle(ctx, source,
        [corners[0]!, corners[1]!, corners[2]!],
        [mapped[0]!, mapped[1]!, mapped[2]!]);
      drawTriangle(ctx, source,
        [corners[0]!, corners[2]!, corners[3]!],
        [mapped[0]!, mapped[2]!, mapped[3]!]);
    }
  }

  return { canvas, x: bounds.x, y: bounds.y };
}
