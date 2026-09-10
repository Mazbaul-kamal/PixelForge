/**
 * A pool of workers, one per core bar the one the main thread needs.
 *
 * Heavy work — filters, flood fills, PSD parsing — goes here so the main
 * thread only paints and handles input.
 */
export class WorkerPool {
  private readonly create: () => Worker;
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly queue: Array<(worker: Worker) => void> = [];
  private readonly size: number;

  constructor(create: () => Worker, size = WorkerPool.defaultSize()) {
    this.create = create;
    this.size = Math.max(1, size);
  }

  static defaultSize(): number {
    const cores = navigator.hardwareConcurrency ?? 2;
    return Math.max(1, cores - 1);
  }

  get poolSize(): number {
    return this.size;
  }

  get created(): number {
    return this.workers.length;
  }

  private acquire(): Promise<Worker> {
    const ready = this.idle.pop();
    if (ready) return Promise.resolve(ready);

    if (this.workers.length < this.size) {
      const worker = this.create();
      this.workers.push(worker);
      return Promise.resolve(worker);
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  private release(worker: Worker): void {
    const waiting = this.queue.shift();
    if (waiting) waiting(worker);
    else this.idle.push(worker);
  }

  /**
   * Runs one task. `match` picks this task's reply out of the worker's
   * messages, since a pooled worker may be reused immediately afterwards.
   */
  async run<Request, Response>(
    request: Request,
    match: (response: Response) => boolean,
    transfer: Transferable[] = [],
  ): Promise<Response> {
    const worker = await this.acquire();

    return new Promise<Response>((resolve, reject) => {
      const onMessage = (event: MessageEvent<Response>): void => {
        if (!match(event.data)) return;
        cleanup();
        resolve(event.data);
      };
      const onError = (event: ErrorEvent): void => {
        cleanup();
        reject(new Error(event.message || 'The background task failed.'));
      };
      const cleanup = (): void => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        this.release(worker);
      };

      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage(request, transfer);
    });
  }

  destroy(): void {
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
    this.idle.length = 0;
    this.queue.length = 0;
  }
}
