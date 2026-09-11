import type { PixelDocument } from './document';
import type { History } from './history';
import { canEditLayer } from './layer-ops';
import { clonePath, emptyPath, pathToMask, pathToPath2D } from './path';
import type { PathAnchor, SubPath, VectorPath } from './path';
import type { CombineMode } from './selection';
import { SelectionMask } from './selection';
import { findCorners, fitOpenCurve, smoothOutline } from './curve-fit';
import type { Cubic } from './curve-fit';
import { traceSelectionLoops } from './selection-contour';
import type { Point } from './types';
import type { StrokeStyle } from './shape-layer';

/** Gives the work path a real name, so it stops being scratch. */
export function savePath(doc: PixelDocument, history: History, name: string): boolean {
  const path = doc.getActivePath();
  if (!path) return false;
  return history.transaction('Save Path', () => {
    doc.setPath({ ...path, name });
    if (doc.workPathId === path.id) doc.workPathId = null;
  });
}

export function renamePath(
  doc: PixelDocument, history: History, id: string, name: string,
): boolean {
  const path = doc.getPath(id);
  if (!path || path.name === name || name.trim() === '') return false;
  return history.transaction('Rename Path', () => {
    doc.setPath({ ...path, name: name.trim() });
  });
}

export function deletePath(doc: PixelDocument, history: History, id: string): boolean {
  if (!doc.getPath(id)) return false;
  return history.transaction('Delete Path', () => {
    doc.removePath(id);
  });
}

export function duplicatePath(doc: PixelDocument, history: History, id: string): boolean {
  const path = doc.getPath(id);
  if (!path) return false;
  return history.transaction('Duplicate Path', () => {
    const copy = clonePath(path, `${path.name} copy`);
    doc.paths.push(copy);
    doc.activePathId = copy.id;
  });
}

export function newPath(doc: PixelDocument, history: History, name: string): boolean {
  return history.transaction('New Path', () => {
    const path = emptyPath(name);
    doc.paths.push(path);
    doc.activePathId = path.id;
    doc.workPathId = null;
  });
}

/** Combines the rasterised path with whatever is already selected. */
export function pathToSelection(
  doc: PixelDocument,
  history: History,
  id: string,
  mode: CombineMode = 'new',
  antiAlias = true,
): boolean {
  const path = doc.getPath(id);
  if (!path) return false;

  const mask = pathToMask(path, doc.width, doc.height, antiAlias);
  return history.transaction('Path to Selection', () => {
    doc.selection = mode === 'new' || !doc.selection
      ? mask
      : doc.selection.combine(mask, mode);
  });
}

/** Turns the current selection into a path, tracing its edge. */
export function selectionToPath(
  doc: PixelDocument, history: History, name = 'Work Path',
): boolean {
  const selection = doc.selection;
  if (!selection) return false;

  const traced = traceMask(selection, name);
  if (!traced) return false;

  return history.transaction('Selection to Path', () => {
    doc.paths.push(traced);
    doc.activePathId = traced.id;
    doc.workPathId = traced.id;
  });
}

/**
 * How far a fitted curve may sit from the traced boundary, in pixels.
 *
 * Measured across circles, ellipses, stars and irregular blobs: 0.8 puts a
 * circle at thirty anchors and 0.2% of pixels differing. Loosening to 1.1
 * saves ten anchors but nearly doubles the error, and tightening to 0.6 costs
 * twenty more anchors for a tenth of a percent. Photoshop's own default is
 * looser still, at two pixels.
 */
const FIT_TOLERANCE = 0.8;
/** Points either side used to measure a turn, and the angle that makes a corner. */
const CORNER_WINDOW = 4;
const CORNER_DEGREES = 62;

/** The cubics of one boundary loop, as anchors. */
function anchorsFromCubics(cubics: readonly Cubic[], closed: boolean): PathAnchor[] {
  if (cubics.length === 0) return [];
  const anchors: PathAnchor[] = [];

  for (let i = 0; i < cubics.length; i += 1) {
    const curve = cubics[i]!;
    const previous = cubics[i - 1];
    anchors.push({
      x: curve.p0.x, y: curve.p0.y,
      inX: previous ? previous.c2.x : curve.p0.x,
      inY: previous ? previous.c2.y : curve.p0.y,
      outX: curve.c1.x, outY: curve.c1.y,
    });
  }

  const last = cubics[cubics.length - 1]!;
  if (closed) {
    // The loop's first anchor takes its incoming handle from the last curve.
    const first = anchors[0]!;
    anchors[0] = { ...first, inX: last.c2.x, inY: last.c2.y };
  } else {
    anchors.push({
      x: last.p3.x, y: last.p3.y,
      inX: last.c2.x, inY: last.c2.y,
      outX: last.p3.x, outY: last.p3.y,
    });
  }
  return anchors;
}

/** Fits one traced loop, keeping its corners sharp. */
function fitLoop(loop: readonly Point[]): SubPath | null {
  if (loop.length < 4) {
    if (loop.length < 3) return null;
    return {
      closed: true,
      anchors: loop.map((point) => ({
        x: point.x, y: point.y, inX: point.x, inY: point.y, outX: point.x, outY: point.y,
      })),
    };
  }

  const smoothed = smoothOutline(loop, true);
  const corners = findCorners(smoothed, true, CORNER_WINDOW, CORNER_DEGREES);

  // No corners: one closed run, cut anywhere, fitted as an open curve whose
  // ends meet. Cutting at a point rather than fitting a closed curve directly
  // keeps the fitter simple, and the join is smoothed by the shared anchor.
  if (corners.length === 0) {
    const rotated = [...smoothed, smoothed[0]!];
    const cubics = fitOpenCurve(rotated, FIT_TOLERANCE);
    const anchors = anchorsFromCubics(cubics, true);
    return anchors.length > 1 ? { closed: true, anchors } : null;
  }

  // With corners, each run between two of them is fitted on its own so the
  // corner stays a corner instead of being rounded off by a single fit.
  const cubics: Cubic[] = [];
  for (let i = 0; i < corners.length; i += 1) {
    const from = corners[i]!;
    const to = corners[(i + 1) % corners.length]!;
    const run: Point[] = [];
    for (let k = from; ; k = (k + 1) % smoothed.length) {
      run.push(smoothed[k]!);
      if (k === to) break;
    }
    if (run.length >= 2) cubics.push(...fitOpenCurve(run, FIT_TOLERANCE));
  }

  const anchors = anchorsFromCubics(cubics, true);
  return anchors.length > 1 ? { closed: true, anchors } : null;
}

/**
 * Turns the mask's boundary into an editable path.
 *
 * The boundary walk is the one the marching ants already use, so a selection
 * and the path made from it trace the same edge — holes and separate islands
 * become their own subpaths. The staircase that walk produces is then fitted
 * with cubics rather than kept as corner points, which is what makes the
 * result editable by hand: a round selection comes back as a handful of smooth
 * anchors instead of hundreds of right angles. Runs that turn sharply are cut
 * at the corner first, so a rectangle keeps its right angles.
 */
function traceMask(mask: SelectionMask, name: string): VectorPath | null {
  const subpaths: SubPath[] = [];

  for (const loop of traceSelectionLoops(mask, false)) {
    const points = loop.map(([x, y]) => ({ x, y }));
    const fitted = fitLoop(points);
    if (fitted) subpaths.push(fitted);
  }

  if (subpaths.length === 0) return null;
  return { ...emptyPath(name), subpaths };
}

/** Fills the path's area on the active layer. */
export function fillPath(
  doc: PixelDocument, history: History, id: string, colour: string,
): boolean {
  const path = doc.getPath(id);
  const layer = doc.getActiveLayer();
  if (!path || !layer || !canEditLayer(layer)) return false;

  return history.pixelTransaction('Fill Path', layer, () => {
    const ctx = layer.ctx;
    ctx.save();
    ctx.translate(-layer.x, -layer.y);
    ctx.fillStyle = colour;
    ctx.fill(pathToPath2D(path), 'nonzero');
    ctx.restore();
  });
}

/** Strokes the path's outline on the active layer. */
export function strokePath(
  doc: PixelDocument,
  history: History,
  id: string,
  stroke: Pick<StrokeStyle, 'colour' | 'width' | 'cap' | 'join'>,
): boolean {
  const path = doc.getPath(id);
  const layer = doc.getActiveLayer();
  if (!path || !layer || !canEditLayer(layer)) return false;

  return history.pixelTransaction('Stroke Path', layer, () => {
    const ctx = layer.ctx;
    ctx.save();
    ctx.translate(-layer.x, -layer.y);
    ctx.strokeStyle = stroke.colour;
    ctx.lineWidth = stroke.width;
    ctx.lineCap = stroke.cap;
    ctx.lineJoin = stroke.join;
    ctx.stroke(pathToPath2D(path));
    ctx.restore();
  });
}
