import {
  anchorCount, createAnchor, emptyPath, hitAnchor, hitSegment, insertAnchor, isCorner,
  isSmooth, moveAnchor, pathToPath2D, removeAnchor, replaceAnchor, setSmoothHandles,
  toCorner, toSmooth,
} from '../core/path';
import type { AnchorHit, PathAnchor, VectorPath } from '../core/path';
import type { Point } from '../core/types';
import type { Tool, ToolContext } from './types';

const ANCHOR_SIZE = 7;
const HANDLE_SIZE = 6;
/** Hit radius in screen pixels, so it stays usable at every zoom. */
const HIT_RADIUS = 9;
/** Past this much movement a click becomes a handle drag. */
const DRAG_THRESHOLD = 2.5;

export interface PenDeps {
  onChanged: () => void;
}

type Dragging =
  | { kind: 'none' }
  | { kind: 'newHandle'; subpath: number; index: number }
  | { kind: 'move'; hit: AnchorHit; last: Point }
  ;

/**
 * The pen tool.
 *
 * Click places a corner point, click-and-drag places a smooth one and pulls
 * its handles out, and clicking the first point closes the shape. The path
 * lives on the document rather than in the tool, so the paths panel, the
 * selection commands and history all see the same object.
 */
export function createPenTool(deps: PenDeps): Tool {
  let drag: Dragging = { kind: 'none' };
  let downAt: Point = { x: 0, y: 0 };
  let moved = false;
  /** The anchor whose handles are shown, so they can be grabbed. */
  let focused: AnchorHit | null = null;
  let hover: Point | null = null;
  /**
   * The path list as it was when the gesture started.
   *
   * A drag writes straight to the document so the overlay shows the real
   * thing, which means by the time the gesture ends the change is already
   * there and a transaction opened now would see nothing to record. So the
   * document is put back to this first, and the transaction then re-applies
   * the result — exactly one entry, with the right before and after.
   */
  let before: { paths: VectorPath[]; activePathId: string | null; workPathId: string | null } | null = null;

  const tolerance = (context: ToolContext): number => HIT_RADIUS / context.viewport.zoom;

  /** The path being drawn, created on first use as an unnamed work path. */
  const ensurePath = (context: ToolContext): VectorPath => {
    const existing = context.doc.getActivePath();
    if (existing) return existing;

    const path = emptyPath('Work Path');
    context.doc.paths.push(path);
    context.doc.activePathId = path.id;
    context.doc.workPathId = path.id;
    return path;
  };

  const snapshot = (context: ToolContext): void => {
    before = {
      paths: [...context.doc.paths],
      activePathId: context.doc.activePathId,
      workPathId: context.doc.workPathId,
    };
  };

  const rewind = (context: ToolContext): void => {
    if (!before) return;
    context.doc.paths = [...before.paths];
    context.doc.activePathId = before.activePathId;
    context.doc.workPathId = before.workPathId;
  };

  const commit = (context: ToolContext, label: string, next: VectorPath): void => {
    const workPath = context.doc.workPathId;
    rewind(context);
    before = null;
    context.history.transaction(label, () => {
      context.doc.setPath(next);
      context.doc.activePathId = next.id;
      context.doc.workPathId = workPath;
    });
    deps.onChanged();
    context.requestRender();
  };

  /** Writes the path without recording, for the middle of a drag. */
  const apply = (context: ToolContext, next: VectorPath): void => {
    context.doc.setPath(next);
    context.requestRender();
  };

  const openSubPath = (path: VectorPath): number => {
    for (let i = path.subpaths.length - 1; i >= 0; i -= 1) {
      if (!path.subpaths[i]!.closed) return i;
    }
    return -1;
  };

  return {
    id: 'pen',
    name: 'Pen',
    shortcut: 'p',
    cursor: 'crosshair',
    options: [
      {
        type: 'select',
        id: 'penMode',
        label: 'Mode',
        choices: [
          { value: 'add', label: 'Add points' },
          { value: 'edit', label: 'Edit points' },
        ],
        default: 'add',
      },
      { type: 'checkbox', id: 'rubberBand', label: 'Rubber band', default: true },
    ],

    onPointerDown(context, pointer) {
      moved = false;
      downAt = pointer.doc;
      snapshot(context);
      const path = ensurePath(context);
      const tol = tolerance(context);
      const editing = context.options.get<string>('penMode') === 'edit' || pointer.ctrlKey;

      // Alt over a point converts it between corner and smooth.
      if (pointer.altKey) {
        const hit = hitAnchor(path, pointer.doc, tol, focused);
        if (hit && hit.part === 'anchor') {
          const sub = path.subpaths[hit.subpath]!;
          const anchor = sub.anchors[hit.index]!;
          const previous = sub.anchors[hit.index - 1] ?? sub.anchors[sub.anchors.length - 1] ?? anchor;
          const next = sub.anchors[hit.index + 1] ?? sub.anchors[0] ?? anchor;
          const converted = isCorner(anchor)
            ? toSmooth(anchor, previous, next)
            : toCorner(anchor);
          focused = hit;
          commit(context, 'Convert Point', replaceAnchor(path, hit.subpath, hit.index, converted));
          return;
        }
      }

      const hit = hitAnchor(path, pointer.doc, tol, focused);

      if (editing) {
        if (hit) {
          focused = { ...hit, part: 'anchor' };
          drag = { kind: 'move', hit, last: pointer.doc };
          return;
        }
        // Clicking a segment inserts a point on it.
        const segment = hitSegment(path, pointer.doc, tol);
        if (segment) {
          commit(context, 'Add Point', insertAnchor(path, segment));
          return;
        }
        focused = null;
        context.requestRender();
        return;
      }

      // Closing: click the first point of the open subpath.
      const open = openSubPath(path);
      if (hit && open >= 0 && hit.subpath === open && hit.index === 0
        && path.subpaths[open]!.anchors.length > 1) {
        const subpaths = path.subpaths.map((sub, i) => (i === open ? { ...sub, closed: true } : sub));
        focused = null;
        commit(context, 'Close Path', { ...path, subpaths });
        return;
      }

      // Dragging an existing point rather than adding another on top of it.
      if (hit) {
        focused = { ...hit, part: 'anchor' };
        drag = { kind: 'move', hit, last: pointer.doc };
        return;
      }

      const anchor = createAnchor(pointer.doc.x, pointer.doc.y);
      let subpaths = path.subpaths.map((sub) => sub);
      let subpath: number;
      let index: number;

      if (open >= 0) {
        const sub = subpaths[open]!;
        subpaths[open] = { ...sub, anchors: [...sub.anchors, anchor] };
        subpath = open;
        index = sub.anchors.length;
      } else {
        subpaths = [...subpaths, { anchors: [anchor], closed: false }];
        subpath = subpaths.length - 1;
        index = 0;
      }

      focused = { subpath, index, part: 'anchor' };
      drag = { kind: 'newHandle', subpath, index };
      apply(context, { ...path, subpaths });
    },

    onPointerMove(context, pointer) {
      hover = pointer.doc;
      const path = context.doc.getActivePath();
      if (!path) {
        context.requestRender();
        return;
      }

      if (!moved && Math.hypot(pointer.doc.x - downAt.x, pointer.doc.y - downAt.y)
        > DRAG_THRESHOLD / context.viewport.zoom) {
        moved = true;
      }

      if (drag.kind === 'newHandle' && moved) {
        const sub = path.subpaths[drag.subpath];
        const anchor = sub?.anchors[drag.index];
        if (!anchor) return;
        apply(context, replaceAnchor(path, drag.subpath, drag.index,
          setSmoothHandles(anchor, pointer.doc.x, pointer.doc.y)));
        return;
      }

      if (drag.kind === 'move' && moved) {
        const sub = path.subpaths[drag.hit.subpath];
        const anchor = sub?.anchors[drag.hit.index];
        if (!anchor) return;

        let updated: PathAnchor;
        if (drag.hit.part === 'anchor') {
          updated = moveAnchor(anchor, pointer.doc.x - drag.last.x, pointer.doc.y - drag.last.y);
        } else if (drag.hit.part === 'out') {
          updated = pointer.altKey
            ? { ...anchor, outX: pointer.doc.x, outY: pointer.doc.y }
            : setSmoothHandles(anchor, pointer.doc.x, pointer.doc.y);
        } else {
          updated = pointer.altKey
            ? { ...anchor, inX: pointer.doc.x, inY: pointer.doc.y }
            : setSmoothHandles(anchor,
              anchor.x - (pointer.doc.x - anchor.x), anchor.y - (pointer.doc.y - anchor.y));
        }

        drag = { ...drag, last: pointer.doc };
        apply(context, replaceAnchor(path, drag.hit.subpath, drag.hit.index, updated));
        return;
      }

      context.requestRender();
    },

    onPointerUp(context) {
      const path = context.doc.getActivePath();
      if (!path) {
        drag = { kind: 'none' };
        return;
      }

      if (drag.kind === 'newHandle') {
        commit(context, moved ? 'Add Curve Point' : 'Add Point', path);
      } else if (drag.kind === 'move' && moved) {
        commit(context, 'Move Point', path);
      } else {
        // Nothing happened, so leave no trace of the gesture.
        rewind(context);
        before = null;
        context.requestRender();
      }
      drag = { kind: 'none' };
      moved = false;
    },

    onKeyDown(context, event) {
      const path = context.doc.getActivePath();
      if (!path) return false;

      if (event.key === 'Escape' || event.key === 'Enter') {
        focused = null;
        context.requestRender();
        return true;
      }

      if ((event.key === 'Delete' || event.key === 'Backspace') && focused) {
        const target = focused;
        focused = null;
        const next = removeAnchor(path, target.subpath, target.index);
        if (anchorCount(next) === 0) {
          rewind(context);
          before = null;
          context.history.transaction('Delete Path', () => {
            context.doc.removePath(path.id);
          });
          deps.onChanged();
          context.requestRender();
          return true;
        }
        commit(context, 'Delete Point', next);
        return true;
      }

      return false;
    },

    drawOverlay(ctx, context) {
      const path = context.doc.getActivePath();
      if (!path) return;
      const { viewport } = context;

      const screen = (x: number, y: number): Point => viewport.docToScreen(x, y);

      // The path itself.
      ctx.save();
      ctx.lineWidth = 1;
      const outline = new Path2D();
      const source = pathToPath2D(path);
      const matrix = new DOMMatrix()
        .translate(viewport.panX, viewport.panY)
        .scale(viewport.zoom);
      outline.addPath(source, matrix);

      ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
      ctx.lineWidth = 3;
      ctx.stroke(outline);
      ctx.strokeStyle = '#4c9ffe';
      ctx.lineWidth = 1.4;
      ctx.stroke(outline);

      // The segment that would be added next.
      const open = openSubPath(path);
      if (open >= 0 && hover && drag.kind === 'none'
        && context.options.get<boolean>('rubberBand')
        && context.options.get<string>('penMode') === 'add') {
        const anchors = path.subpaths[open]!.anchors;
        const last = anchors[anchors.length - 1];
        if (last) {
          const a = screen(last.x, last.y);
          const b = screen(hover.x, hover.y);
          ctx.beginPath();
          ctx.setLineDash([4, 3]);
          ctx.strokeStyle = 'rgba(76, 159, 254, 0.75)';
          ctx.lineWidth = 1;
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      // Handles for the focused point only, which keeps a dense path readable.
      if (focused) {
        const sub = path.subpaths[focused.subpath];
        const anchor = sub?.anchors[focused.index];
        if (anchor && !isCorner(anchor)) {
          const centre = screen(anchor.x, anchor.y);
          for (const [hx, hy] of [[anchor.inX, anchor.inY], [anchor.outX, anchor.outY]]) {
            const handle = screen(hx!, hy!);
            ctx.beginPath();
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.lineWidth = 2.5;
            ctx.moveTo(centre.x, centre.y);
            ctx.lineTo(handle.x, handle.y);
            ctx.stroke();
            ctx.beginPath();
            ctx.strokeStyle = '#4c9ffe';
            ctx.lineWidth = 1;
            ctx.moveTo(centre.x, centre.y);
            ctx.lineTo(handle.x, handle.y);
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(handle.x, handle.y, HANDLE_SIZE / 2, 0, Math.PI * 2);
            ctx.fillStyle = '#4c9ffe';
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }
      }

      // The points.
      for (let s = 0; s < path.subpaths.length; s += 1) {
        const anchors = path.subpaths[s]!.anchors;
        for (let i = 0; i < anchors.length; i += 1) {
          const anchor = anchors[i]!;
          const at = screen(anchor.x, anchor.y);
          const active = focused?.subpath === s && focused.index === i;
          const size = ANCHOR_SIZE;

          ctx.beginPath();
          // A square means the curve kinks here, which covers both a plain
          // corner and a fitted one whose handles simply are not collinear.
          if (isSmooth(anchor)) {
            ctx.arc(at.x, at.y, size / 2, 0, Math.PI * 2);
          } else {
            ctx.rect(at.x - size / 2, at.y - size / 2, size, size);
          }
          ctx.fillStyle = active ? '#4c9ffe' : '#ffffff';
          ctx.fill();
          ctx.strokeStyle = active ? '#ffffff' : '#1b1b1b';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      ctx.restore();
    },

    deactivate() {
      drag = { kind: 'none' };
      focused = null;
      hover = null;
      // A half-finished gesture must not rewind the next one.
      before = null;
    },
  };
}
