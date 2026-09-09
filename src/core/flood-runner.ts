import { runFloodTask } from './flood-worker';
import type { FloodResult, FloodTask } from './flood-worker';

/** Omit over a union has to distribute, or only the shared keys survive. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type FloodRequest = DistributiveOmit<FloodTask, 'id'>;

/** Above this many pixels the scan moves off the main thread. */
export const WORKER_PIXEL_THRESHOLD = 4_000_000;

/**
 * Runs wand, grow and similar scans. Small documents run inline, because a
 * worker round trip costs more than the scan; large ones go to a worker so a
 * 20 megapixel image never freezes the UI.
 */
export class FloodRunner {
  private worker: Worker | null = null;
  private nextId = 1;

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    try {
      this.worker = new Worker(new URL('./flood-worker.ts', import.meta.url), { type: 'module' });
    } catch {
      // No worker support: everything falls back to the inline path.
      this.worker = null;
    }
    return this.worker;
  }

  async run(task: FloodRequest): Promise<Uint8ClampedArray> {
    const pixelCount = task.width * task.height;
    const worker = pixelCount > WORKER_PIXEL_THRESHOLD ? this.ensureWorker() : null;
    const full = { ...task, id: this.nextId++ } as FloodTask;

    if (!worker) return runFloodTask(full);

    return new Promise<Uint8ClampedArray>((resolve) => {
      const onMessage = (event: MessageEvent<FloodResult>): void => {
        if (event.data.id !== full.id) return;
        worker.removeEventListener('message', onMessage);
        resolve(event.data.mask);
      };
      worker.addEventListener('message', onMessage);
      // The pixel buffer came from getImageData, so handing it over is safe.
      worker.postMessage(full, [full.pixels.buffer]);
    });
  }

  destroy(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
