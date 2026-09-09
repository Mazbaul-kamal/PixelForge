export const DEFAULT_FOREGROUND = '#000000';
export const DEFAULT_BACKGROUND = '#ffffff';

/** Foreground and background colours, shared by every tool that paints. */
export class ColourState {
  private fg = DEFAULT_FOREGROUND;
  private bg = DEFAULT_BACKGROUND;
  private readonly listeners = new Set<() => void>();

  get foreground(): string {
    return this.fg;
  }

  set foreground(value: string) {
    if (value === this.fg) return;
    this.fg = value;
    this.notify();
  }

  get background(): string {
    return this.bg;
  }

  set background(value: string) {
    if (value === this.bg) return;
    this.bg = value;
    this.notify();
  }

  swap(): void {
    [this.fg, this.bg] = [this.bg, this.fg];
    this.notify();
  }

  reset(): void {
    if (this.fg === DEFAULT_FOREGROUND && this.bg === DEFAULT_BACKGROUND) return;
    this.fg = DEFAULT_FOREGROUND;
    this.bg = DEFAULT_BACKGROUND;
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
