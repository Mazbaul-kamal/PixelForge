import type { History } from '../../core/history';
import { createPanel } from '../panel';

/** Lists every history entry, highlights the current one, jumps on click. */
export class HistoryPanel {
  readonly root: HTMLElement;
  private readonly history: History;
  private readonly list: HTMLElement;
  private readonly unsubscribe: () => void;
  private rows: HTMLButtonElement[] = [];
  private renderedVersion = -1;

  constructor(history: History) {
    this.history = history;

    const panel = createPanel('History', 'history');
    this.root = panel.root;

    this.list = document.createElement('div');
    this.list.className = 'pf-history-list';
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', 'History states');
    panel.body.appendChild(this.list);

    this.unsubscribe = history.subscribe(() => this.refresh());
    this.refresh();
  }

  destroy(): void {
    this.unsubscribe();
    this.root.remove();
  }

  private refresh(): void {
    if (this.renderedVersion !== this.history.version) this.rebuild();
    this.updateSelection();
  }

  private rebuild(): void {
    const labels = [this.history.baseLabel, ...this.history.entryLabels];

    this.rows = labels.map((label, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'pf-history-row';
      row.textContent = label;
      row.setAttribute('role', 'option');
      row.addEventListener('click', () => this.history.jumpTo(index));
      return row;
    });

    this.list.replaceChildren(...this.rows);
    this.renderedVersion = this.history.version;
  }

  private updateSelection(): void {
    const current = this.history.index;
    this.rows.forEach((row, index) => {
      row.classList.toggle('is-current', index === current);
      // Entries past the cursor are the redo tail: still reachable, but undone.
      row.classList.toggle('is-undone', index > current);
      row.setAttribute('aria-selected', index === current ? 'true' : 'false');
    });
    // Scroll this list only. scrollIntoView walks every scrollable ancestor,
    // which now includes the panel column, so a new entry would drag the
    // Layers panel off the top of the sidebar.
    const row = this.rows[current];
    const box = this.list.parentElement;
    if (row && box) {
      const top = row.offsetTop;
      const bottom = top + row.offsetHeight;
      if (top < box.scrollTop) box.scrollTop = top;
      else if (bottom > box.scrollTop + box.clientHeight) {
        box.scrollTop = bottom - box.clientHeight;
      }
    }
  }
}
