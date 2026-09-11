import type { PixelDocument } from './document';
import type { History } from './history';
import type { Axis } from './snapping';

/**
 * A ruler guide. Unlike the transient alignment guides in snapping.ts — which
 * appear while a layer is being dragged and vanish when it lands — these are
 * placed by the user, belong to the document and are saved with it.
 */
export interface DocumentGuide {
  readonly axis: Axis;
  /** Document coordinate. A vertical guide sits at an x, a horizontal at a y. */
  readonly position: number;
}

/** View preferences for the ruler, guide and grid furniture. */
export interface GuideSettings {
  rulers: boolean;
  guides: boolean;
  grid: boolean;
  snap: boolean;
  gridSpacing: number;
  gridSubdivisions: number;
}

export function defaultGuideSettings(): GuideSettings {
  return {
    rulers: true, guides: true, grid: false, snap: true,
    gridSpacing: 100, gridSubdivisions: 4,
  };
}

/** Guides land on whole pixels; a half-pixel guide is never what was meant. */
function normalise(position: number): number {
  return Math.round(position);
}

export function addGuide(
  doc: PixelDocument, history: History, axis: Axis, position: number,
): boolean {
  const at = normalise(position);
  const limit = axis === 'x' ? doc.width : doc.height;
  if (at < 0 || at > limit) return false;
  if (doc.guides.some((guide) => guide.axis === axis && guide.position === at)) return false;

  return history.transaction('New Guide', () => {
    doc.guides = [...doc.guides, { axis, position: at }];
  });
}

export function moveGuide(
  doc: PixelDocument, history: History, index: number, position: number,
): boolean {
  const guide = doc.guides[index];
  if (!guide) return false;
  const at = normalise(position);
  if (at === guide.position) return false;

  return history.transaction('Move Guide', () => {
    doc.guides = doc.guides.map((existing, i) => (
      i === index ? { ...existing, position: at } : existing
    ));
  });
}

export function removeGuide(doc: PixelDocument, history: History, index: number): boolean {
  if (!doc.guides[index]) return false;
  return history.transaction('Delete Guide', () => {
    doc.guides = doc.guides.filter((_, i) => i !== index);
  });
}

export function clearGuides(doc: PixelDocument, history: History): boolean {
  if (doc.guides.length === 0) return false;
  return history.transaction('Clear Guides', () => {
    doc.guides = [];
  });
}

/** The guide under a document-space point, within a tolerance. */
export function guideAt(
  doc: PixelDocument, x: number, y: number, tolerance: number,
): number {
  for (let i = 0; i < doc.guides.length; i += 1) {
    const guide = doc.guides[i]!;
    const distance = guide.axis === 'x' ? Math.abs(x - guide.position) : Math.abs(y - guide.position);
    if (distance <= tolerance) return i;
  }
  return -1;
}

/** Grid line positions along one axis, including the subdivisions. */
export function gridLines(
  settings: GuideSettings, extent: number,
): { major: number[]; minor: number[] } {
  const major: number[] = [];
  const minor: number[] = [];
  const spacing = Math.max(2, settings.gridSpacing);
  const divisions = Math.max(1, Math.round(settings.gridSubdivisions));
  const step = spacing / divisions;

  for (let at = 0; at <= extent + 0.001; at += step) {
    const isMajor = Math.abs((at / spacing) - Math.round(at / spacing)) < 1e-6;
    (isMajor ? major : minor).push(at);
  }
  return { major, minor };
}
