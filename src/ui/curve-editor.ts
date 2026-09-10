import { curveLut } from '../core/adjustments';
import type { CurvePoint } from '../core/adjustments';

const SIZE = 220;
const GRAB_RADIUS = 10;

export interface CurveEditorHandle {
  readonly element: HTMLElement;
  readonly points: () => CurvePoint[];
  reset(): void;
}

/**
 * A draggable curve. Points are added by clicking empty space and removed by
 * dragging them off the square, which is how every editor does it.
 */
export function createCurveEditor(
  initial: readonly CurvePoint[],
  onChange: (points: CurvePoint[]) => void,
): CurveEditorHandle {
  let points: CurvePoint[] = initial.map((p) => [p[0], p[1]] as CurvePoint);

  const canvas = document.createElement('canvas');
  canvas.className = 'pf-curve-editor';
  canvas.width = SIZE;
  canvas.height = SIZE;

  const toCanvas = (p: CurvePoint): [number, number] => [
    (p[0] / 255) * SIZE,
    SIZE - (p[1] / 255) * SIZE,
  ];
  const fromCanvas = (x: number, y: number): CurvePoint => [
    Math.max(0, Math.min(255, Math.round((x / SIZE) * 255))),
    Math.max(0, Math.min(255, Math.round(((SIZE - y) / SIZE) * 255))),
  ];

  const paint = (): void => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const at = (i / 4) * SIZE;
      ctx.beginPath();
      ctx.moveTo(at, 0); ctx.lineTo(at, SIZE);
      ctx.moveTo(0, at); ctx.lineTo(SIZE, at);
      ctx.stroke();
    }

    const lut = curveLut(points);
    ctx.strokeStyle = '#4c9ffe';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * SIZE;
      const y = SIZE - (lut[i]! / 255) * SIZE;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    for (const point of points) {
      const [x, y] = toCanvas(point);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  };

  const sortPoints = (): void => {
    points.sort((a, b) => a[0] - b[0]);
  };

  canvas.addEventListener('pointerdown', (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * SIZE;
    const y = ((event.clientY - rect.top) / rect.height) * SIZE;

    let index = points.findIndex((p) => {
      const [px, py] = toCanvas(p);
      return Math.hypot(px - x, py - y) <= GRAB_RADIUS;
    });

    if (index < 0) {
      points.push(fromCanvas(x, y));
      sortPoints();
      index = points.findIndex((p) => p[0] === fromCanvas(x, y)[0]);
      paint();
      onChange([...points]);
    }

    canvas.setPointerCapture(event.pointerId);
    let removing = false;

    const onMove = (move: PointerEvent): void => {
      const mx = ((move.clientX - rect.left) / rect.width) * SIZE;
      const my = ((move.clientY - rect.top) / rect.height) * SIZE;
      // Dragged well clear of the square: drop the point.
      removing = points.length > 2 && (mx < -20 || mx > SIZE + 20 || my < -20 || my > SIZE + 20);

      const moved = fromCanvas(Math.max(0, Math.min(SIZE, mx)), Math.max(0, Math.min(SIZE, my)));
      points[index] = moved;
      sortPoints();
      index = points.indexOf(moved);
      paint();
      onChange([...points]);
    };

    const onUp = (): void => {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      if (removing && points.length > 2) {
        points.splice(index, 1);
        paint();
        onChange([...points]);
      }
    };

    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
  });

  paint();

  return {
    element: canvas,
    points: () => [...points],
    reset: () => {
      points = [[0, 0], [255, 255]];
      paint();
      onChange([...points]);
    },
  };
}

/** Draws a histogram, for the Levels dialog. */
export function createHistogram(counts: Uint32Array): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.className = 'pf-histogram';
  canvas.width = 256;
  canvas.height = 80;

  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  let peak = 1;
  for (const value of counts) if (value > peak) peak = value;

  ctx.fillStyle = 'rgba(216, 216, 216, 0.85)';
  for (let i = 0; i < 256; i++) {
    // Square root scaling, or one spike flattens everything else.
    const height = Math.sqrt(counts[i]! / peak) * canvas.height;
    ctx.fillRect(i, canvas.height - height, 1, height);
  }
  return canvas;
}
