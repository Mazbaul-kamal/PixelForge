import type { PixelDocument } from '../../core/document';
import type { History } from '../../core/history';
import { anchorCount } from '../../core/path';
import type { VectorPath } from '../../core/path';
import {
  deletePath, duplicatePath, fillPath, newPath, pathToSelection, renamePath,
  savePath, selectionToPath, strokePath,
} from '../../core/path-ops';
import { createPanel } from '../panel';

export interface PathsPanelDeps {
  readonly doc: PixelDocument;
  readonly history: History;
  readonly changed: () => void;
  readonly notify: (message: string, detail?: string) => void;
  /** Foreground colour, for filling and stroking. */
  readonly colour: () => string;
  readonly strokeWidth: () => number;
}

function button(label: string, title: string, run: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = 'pf-icon-button';
  element.textContent = label;
  element.title = title;
  element.addEventListener('click', run);
  return element;
}

/**
 * Lists the document's paths and the things you can do with one: turn it into
 * a selection, fill it, stroke it, or the other way round.
 */
export class PathsPanel {
  readonly root: HTMLElement;
  private readonly deps: PathsPanelDeps;
  private readonly list: HTMLElement;
  private readonly unsubscribe: () => void;
  private renaming: string | null = null;

  constructor(deps: PathsPanelDeps) {
    this.deps = deps;

    const panel = createPanel('Paths', 'paths');
    this.root = panel.root;

    this.list = document.createElement('div');
    this.list.className = 'pf-path-list';
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', 'Paths');
    panel.body.appendChild(this.list);

    const actions = document.createElement('div');
    actions.className = 'pf-path-actions';
    actions.append(
      button('◌', 'Load the path as a selection', () => this.act(
        (id) => pathToSelection(this.deps.doc, this.deps.history, id),
        'Select a path first.',
      )),
      button('⬚', 'Make a path from the selection', () => {
        if (!selectionToPath(this.deps.doc, this.deps.history)) {
          this.deps.notify('Select something first.', 'The selection becomes a path.');
          return;
        }
        this.deps.changed();
        this.render();
      }),
      button('■', 'Fill the path on the active layer', () => this.act(
        (id) => fillPath(this.deps.doc, this.deps.history, id, this.deps.colour()),
        'Select a path and an editable layer first.',
      )),
      button('◯', 'Stroke the path on the active layer', () => this.act(
        (id) => strokePath(this.deps.doc, this.deps.history, id, {
          colour: this.deps.colour(),
          width: this.deps.strokeWidth(),
          cap: 'round',
          join: 'round',
        }),
        'Select a path and an editable layer first.',
      )),
      button('+', 'New empty path', () => {
        newPath(this.deps.doc, this.deps.history, this.nextName());
        this.deps.changed();
        this.render();
      }),
      button('⧉', 'Duplicate the path', () => this.act(
        (id) => duplicatePath(this.deps.doc, this.deps.history, id),
        'Select a path first.',
      )),
      button('🗑', 'Delete the path', () => this.act(
        (id) => deletePath(this.deps.doc, this.deps.history, id),
        'Select a path first.',
      )),
    );
    panel.body.appendChild(actions);

    this.unsubscribe = deps.history.subscribe(() => this.render());
    this.render();
  }

  destroy(): void {
    this.unsubscribe();
    this.root.remove();
  }

  private nextName(): string {
    let index = this.deps.doc.paths.length + 1;
    const taken = new Set(this.deps.doc.paths.map((path) => path.name));
    while (taken.has(`Path ${index}`)) index += 1;
    return `Path ${index}`;
  }

  private act(run: (id: string) => boolean, failure: string): void {
    const id = this.deps.doc.activePathId;
    if (!id || !run(id)) {
      this.deps.notify(failure);
      return;
    }
    this.deps.changed();
    this.render();
  }

  render(): void {
    const { doc } = this.deps;
    this.list.replaceChildren();

    if (doc.paths.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'pf-path-empty';
      empty.textContent = 'No paths yet. Draw one with the Pen tool (P).';
      this.list.appendChild(empty);
      return;
    }

    for (const path of doc.paths) {
      this.list.appendChild(this.row(path));
    }
  }

  private row(path: VectorPath): HTMLElement {
    const { doc } = this.deps;
    const row = document.createElement('div');
    row.className = 'pf-path-row';
    row.classList.toggle('is-active', doc.activePathId === path.id);
    row.classList.toggle('is-work', doc.workPathId === path.id);

    const name = document.createElement('span');
    name.className = 'pf-path-name';
    name.textContent = path.name;

    const count = document.createElement('span');
    count.className = 'pf-path-count';
    const points = anchorCount(path);
    count.textContent = `${points} ${points === 1 ? 'point' : 'points'}`;

    row.append(name, count);

    row.addEventListener('click', () => {
      doc.activePathId = path.id;
      this.deps.changed();
      this.render();
    });

    // A work path is scratch until it is named, which is what double-click does.
    name.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      this.beginRename(path, name);
    });

    return row;
  }

  private beginRename(path: VectorPath, label: HTMLElement): void {
    if (this.renaming) return;
    this.renaming = path.id;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'pf-path-rename';
    input.value = path.name;

    const finish = (commit: boolean): void => {
      if (this.renaming !== path.id) return;
      this.renaming = null;
      const value = input.value.trim();
      input.replaceWith(label);
      if (commit && value && value !== path.name) {
        if (this.deps.doc.workPathId === path.id) {
          savePath(this.deps.doc, this.deps.history, value);
        } else {
          renamePath(this.deps.doc, this.deps.history, path.id, value);
        }
        this.deps.changed();
      }
      this.render();
    };

    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') finish(true);
      if (event.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));

    label.replaceWith(input);
    input.focus();
    input.select();
  }
}
