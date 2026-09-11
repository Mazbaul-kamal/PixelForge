import type { PixelDocument } from './document';
import { gridLines } from './guides';
import type { GuideSettings } from './guides';
import type { Layer, Rect } from './types';

export type Axis = 'x' | 'y';

export interface SnapTarget {
  readonly axis: Axis;
  /** Document coordinate the edge sits at. */
  readonly position: number;
  /** Span of the source along the other axis, used to size the guide line. */
  readonly from: number;
  readonly to: number;
}

export interface Guide {
  readonly axis: Axis;
  readonly position: number;
  readonly from: number;
  readonly to: number;
}

export interface SnapOutcome {
  readonly dx: number;
  readonly dy: number;
  readonly guides: readonly Guide[];
}

export function layerRect(layer: Layer): Rect {
  return { x: layer.x, y: layer.y, width: layer.canvas.width, height: layer.canvas.height };
}

function edgesOf(rect: Rect, axis: Axis): number[] {
  return axis === 'x'
    ? [rect.x, rect.x + rect.width / 2, rect.x + rect.width]
    : [rect.y, rect.y + rect.height / 2, rect.y + rect.height];
}

function spanOf(rect: Rect, axis: Axis): { from: number; to: number } {
  // The guide runs along the OTHER axis from the one it aligns on.
  return axis === 'x'
    ? { from: rect.y, to: rect.y + rect.height }
    : { from: rect.x, to: rect.x + rect.width };
}

function pushTargets(out: SnapTarget[], rect: Rect, axis: Axis): void {
  const span = spanOf(rect, axis);
  for (const position of edgesOf(rect, axis)) {
    out.push({ axis, position, from: span.from, to: span.to });
  }
}

/**
 * Everything the moving layer can align to: the document edges and centre,
 * and the edges and centres of the other visible layers.
 */
/**
 * Ruler guides and grid lines as snap targets.
 *
 * They span the whole document rather than a layer's extent, so the alignment
 * line the move tool draws runs the full width or height — which is what makes
 * it read as "you are on the guide" rather than "you are next to something".
 */
export function guideSnapTargets(
  doc: PixelDocument, settings: GuideSettings,
): SnapTarget[] {
  const targets: SnapTarget[] = [];
  if (!settings.snap) return targets;

  if (settings.guides) {
    for (const guide of doc.guides) {
      targets.push(guide.axis === 'x'
        ? { axis: 'x', position: guide.position, from: 0, to: doc.height }
        : { axis: 'y', position: guide.position, from: 0, to: doc.width });
    }
  }

  if (settings.grid) {
    for (const at of gridLines(settings, doc.width).major) {
      targets.push({ axis: 'x', position: at, from: 0, to: doc.height });
    }
    for (const at of gridLines(settings, doc.height).major) {
      targets.push({ axis: 'y', position: at, from: 0, to: doc.width });
    }
  }

  return targets;
}

export function collectSnapTargets(doc: PixelDocument, movingLayerId: string): SnapTarget[] {
  const targets: SnapTarget[] = [];
  const documentRect: Rect = { x: 0, y: 0, width: doc.width, height: doc.height };

  pushTargets(targets, documentRect, 'x');
  pushTargets(targets, documentRect, 'y');

  for (const layer of doc.layers) {
    if (layer.id === movingLayerId || !layer.visible) continue;
    const rect = layerRect(layer);
    if (rect.width === 0 || rect.height === 0) continue;
    pushTargets(targets, rect, 'x');
    pushTargets(targets, rect, 'y');
  }

  return targets;
}

/** Picks the closest alignment per axis, then reports every line that matches. */
export function computeSnap(
  moving: Rect,
  targets: readonly SnapTarget[],
  threshold: number,
): SnapOutcome {
  const dx = bestDelta(moving, targets, 'x', threshold);
  const dy = bestDelta(moving, targets, 'y', threshold);

  const snapped: Rect = { ...moving, x: moving.x + dx, y: moving.y + dy };
  const guides: Guide[] = [];

  for (const axis of ['x', 'y'] as const) {
    const edges = edgesOf(snapped, axis);
    const span = spanOf(snapped, axis);

    for (const target of targets) {
      if (target.axis !== axis) continue;
      if (!edges.some((edge) => Math.abs(edge - target.position) < 1e-6)) continue;

      guides.push({
        axis,
        position: target.position,
        from: Math.min(span.from, target.from),
        to: Math.max(span.to, target.to),
      });
    }
  }

  return { dx, dy, guides };
}

function bestDelta(
  moving: Rect,
  targets: readonly SnapTarget[],
  axis: Axis,
  threshold: number,
): number {
  let best = 0;
  let bestDistance = Infinity;

  for (const edge of edgesOf(moving, axis)) {
    for (const target of targets) {
      if (target.axis !== axis) continue;

      const delta = target.position - edge;
      const distance = Math.abs(delta);
      if (distance <= threshold && distance < bestDistance) {
        bestDistance = distance;
        best = delta;
      }
    }
  }

  return best;
}
