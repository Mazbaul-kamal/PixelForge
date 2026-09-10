import { applyFilter } from './filters';
import type { FilterRequest } from './filters';
import type { FilterResponse, FilterTask } from './filter-worker';

/** Above this many pixels the filter moves off the main thread. */
export const WORKER_PIXEL_THRESHOLD = 250_000;

/**
 * Runs filters. Small regions run inline, because a worker round trip costs
 * more than the work; anything larger goes to a worker so the dialog stays
 * responsive and can be cancelled.
 */
export class FilterRunner {
  private worker: Worker | null = null;
  private nextId = 1;
  private cancelled = new Set<number>();

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    try {
      this.worker = new Worker(new URL('./filter-worker.ts', import.meta.url), { type: 'module' });
    } catch {
      this.worker = null;
    }
    return this.worker;
  }

  /** Resolves with null when the run was cancelled. */
  run(request: FilterRequest): { id: number; result: Promise<Uint8ClampedArray | null> } {
    const id = this.nextId++;
    const pixelCount = request.width * request.height;
    const worker = pixelCount > WORKER_PIXEL_THRESHOLD ? this.ensureWorker() : null;

    if (!worker) {
      const pixels = applyFilter(request);
      return { id, result: Promise.resolve(this.cancelled.has(id) ? null : pixels) };
    }

    const task: FilterTask = { ...request, id };
    const result = new Promise<Uint8ClampedArray | null>((resolve) => {
      const onMessage = (event: MessageEvent<FilterResponse>): void => {
        if (event.data.id !== id) return;
        worker.removeEventListener('message', onMessage);
        resolve(this.cancelled.has(id) ? null : event.data.pixels);
        this.cancelled.delete(id);
      };
      worker.addEventListener('message', onMessage);
      worker.postMessage(task, [request.pixels.buffer]);
    });
    return { id, result };
  }

  cancel(id: number): void {
    this.cancelled.add(id);
  }

  destroy(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
