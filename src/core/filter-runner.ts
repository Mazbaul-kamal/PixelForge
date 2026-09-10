import { applyFilter } from './filters';
import type { FilterRequest } from './filters';
import type { FilterResponse, FilterTask } from './filter-worker';
import { WorkerPool } from './worker-pool';

/** Above this many pixels the filter moves off the main thread. */
export const WORKER_PIXEL_THRESHOLD = 250_000;

/**
 * Runs filters. Small regions run inline, because a worker round trip costs
 * more than the work; anything larger goes to a worker so the dialog stays
 * responsive and can be cancelled.
 */
export class FilterRunner {
  private pool: WorkerPool | null = null;
  private nextId = 1;
  private cancelled = new Set<number>();

  private ensurePool(): WorkerPool | null {
    if (this.pool) return this.pool;
    try {
      this.pool = new WorkerPool(
        () => new Worker(new URL('./filter-worker.ts', import.meta.url), { type: 'module' }),
      );
    } catch {
      this.pool = null;
    }
    return this.pool;
  }

  get poolSize(): number {
    return this.pool?.poolSize ?? 0;
  }

  /** Resolves with null when the run was cancelled. */
  run(request: FilterRequest): { id: number; result: Promise<Uint8ClampedArray | null> } {
    const id = this.nextId++;
    const pixelCount = request.width * request.height;
    const pool = pixelCount > WORKER_PIXEL_THRESHOLD ? this.ensurePool() : null;

    if (!pool) {
      const pixels = applyFilter(request);
      return { id, result: Promise.resolve(this.cancelled.has(id) ? null : pixels) };
    }

    const task: FilterTask = { ...request, id };
    const result = pool
      .run<FilterTask, FilterResponse>(task, (response) => response.id === id, [request.pixels.buffer])
      .then((response) => {
        const cancelled = this.cancelled.has(id);
        this.cancelled.delete(id);
        return cancelled ? null : response.pixels;
      });
    return { id, result };
  }

  cancel(id: number): void {
    this.cancelled.add(id);
  }

  destroy(): void {
    this.pool?.destroy();
    this.pool = null;
  }
}
