import type { PixelDocument } from './document';
import type { History } from './history';
import { canEditLayer } from './layer-ops';
import { clonePath, emptyPath, pathToMask, pathToPath2D } from './path';
import type { VectorPath } from './path';
import type { CombineMode } from './selection';
import { SelectionMask } from './selection';
import { traceSelectionLoops } from './selection-contour';
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
 * Turns the mask's boundary into an editable path.
 *
 * The boundary walk is the one the marching ants already use, so a selection
 * and the path made from it trace the same edge — holes and separate islands
 * become their own subpaths. Photoshop fits curves to the outline; these stay
 * corner points, which is exact and still editable because straight runs have
 * already been collapsed.
 */
function traceMask(mask: SelectionMask, name: string): VectorPath | null {
  const subpaths = traceSelectionLoops(mask)
    .filter((loop) => loop.length >= 3)
    .map((loop) => ({
      closed: true,
      anchors: loop.map(([x, y]) => ({ x, y, inX: x, inY: y, outX: x, outY: y })),
    }));

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
