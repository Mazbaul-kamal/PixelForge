/** The standard zoom stops. Stepped zooming lands exactly on these. */
export const ZOOM_LADDER: readonly number[] = [
  1 / 16,
  1 / 8,
  1 / 4,
  1 / 3,
  1 / 2,
  1,
  2,
  3,
  4,
  8,
  16,
  32,
];

// Floating point means 1/3 never compares exactly, so stops are matched loosely.
const EPSILON = 1e-6;

/** The next stop above or below `zoom`. Stops at the ends of the ladder. */
export function nextZoomStop(zoom: number, direction: 1 | -1): number {
  if (direction > 0) {
    for (const stop of ZOOM_LADDER) {
      if (stop > zoom + EPSILON) return stop;
    }
    return ZOOM_LADDER[ZOOM_LADDER.length - 1]!;
  }

  for (let i = ZOOM_LADDER.length - 1; i >= 0; i--) {
    const stop = ZOOM_LADDER[i]!;
    if (stop < zoom - EPSILON) return stop;
  }
  return ZOOM_LADDER[0]!;
}

/** The ladder stop closest to `zoom`, measured on a log scale. */
export function nearestZoomStop(zoom: number): number {
  let best = ZOOM_LADDER[0]!;
  let bestDistance = Infinity;

  for (const stop of ZOOM_LADDER) {
    const distance = Math.abs(Math.log(stop) - Math.log(zoom));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = stop;
    }
  }
  return best;
}

/** "6.25", "33.33", "100" — trailing zeros trimmed so stops read exactly. */
export function formatZoomPercent(zoom: number): string {
  const percent = zoom * 100;
  const rounded = Math.round(percent * 100) / 100;
  return String(rounded);
}

/**
 * Reads "450", "450%" or "45.5" as a zoom factor. Null when unusable.
 * The result is not clamped; Viewport.setZoom does that.
 */
export function parseZoomPercent(text: string): number | null {
  const cleaned = text.trim().replace(/%$/, '').replace(/,/g, '');
  if (cleaned.length === 0) return null;

  const percent = Number(cleaned);
  if (!Number.isFinite(percent) || percent <= 0) return null;
  return percent / 100;
}
