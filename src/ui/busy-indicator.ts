/** Only shown once an operation has run long enough to be noticed. */
const SHOW_AFTER_MS = 150;

/** A small "working" badge for scans that take a while. */
export class BusyIndicator {
  private readonly root: HTMLElement;
  private timer = 0;
  private depth = 0;

  constructor(host: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'pf-busy';
    this.root.hidden = true;
    this.root.setAttribute('role', 'status');
    host.appendChild(this.root);
  }

  /** Wraps a promise, showing the badge if it outlasts the delay. */
  async during<T>(label: string, work: Promise<T>): Promise<T> {
    this.depth += 1;
    if (this.timer === 0) {
      this.timer = window.setTimeout(() => {
        this.root.textContent = label;
        this.root.hidden = false;
      }, SHOW_AFTER_MS);
    }

    try {
      return await work;
    } finally {
      this.depth -= 1;
      if (this.depth === 0) {
        if (this.timer !== 0) window.clearTimeout(this.timer);
        this.timer = 0;
        this.root.hidden = true;
      }
    }
  }
}
