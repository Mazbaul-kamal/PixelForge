import type { PsdParseResult } from './psd-worker';

/**
 * Refuse anything this large up front. A PSD is expanded several times over
 * while parsing, so a file near this size will exhaust memory; saying so is
 * far better than a tab that dies without explanation.
 */
export const MAX_PSD_BYTES = 1_200_000_000;

export class PsdRunner {
  private worker: Worker | null = null;
  private nextId = 1;

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    try {
      this.worker = new Worker(new URL('./psd-worker.ts', import.meta.url), { type: 'module' });
    } catch {
      this.worker = null;
    }
    return this.worker;
  }

  /** Parses off the main thread, so a very large file cannot freeze the tab. */
  async parse(file: File): Promise<PsdParseResult> {
    const id = this.nextId++;

    if (file.size > MAX_PSD_BYTES) {
      const gigabytes = (file.size / 1_000_000_000).toFixed(2);
      return {
        id, width: 0, height: 0, colourMode: 3, bitsPerChannel: 8,
        layers: [], composite: undefined, xmp: undefined, guides: [],
        error:
          `“${file.name}” is ${gigabytes} GB, which is larger than this browser tab can hold. ` +
          'Try flattening it or splitting it up in the application that made it.',
      };
    }

    const buffer = await file.arrayBuffer();
    const worker = this.ensureWorker();
    if (!worker) {
      return {
        id, width: 0, height: 0, colourMode: 3, bitsPerChannel: 8,
        layers: [], composite: undefined, xmp: undefined, guides: [],
        error: 'This browser cannot run the background worker needed to read PSD files.',
      };
    }

    return new Promise<PsdParseResult>((resolve) => {
      const onMessage = (event: MessageEvent<PsdParseResult>): void => {
        if (event.data.id !== id) return;
        worker.removeEventListener('message', onMessage);
        resolve(event.data);
      };
      worker.addEventListener('message', onMessage);
      worker.postMessage({ id, buffer }, [buffer]);
    });
  }

  destroy(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}

export function isPsdFile(file: File): boolean {
  return /\.ps[db]$/i.test(file.name) || file.type === 'image/vnd.adobe.photoshop';
}
