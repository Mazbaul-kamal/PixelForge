import type { History } from '../core/history';

/**
 * Warns before leaving with unsaved work. Browsers ignore custom text here and
 * show their own wording, so returnValue only needs to be set.
 */
export class UnsavedGuard {
  private unsaved = false;
  private readonly detach: () => void;

  constructor(history: History) {
    const unsubscribe = history.subscribe(() => {
      this.unsaved = true;
    });

    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!this.unsaved) return;
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    this.detach = () => {
      unsubscribe();
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }

  get hasUnsavedChanges(): boolean {
    return this.unsaved;
  }

  markSaved(): void {
    this.unsaved = false;
  }

  destroy(): void {
    this.detach();
  }
}
