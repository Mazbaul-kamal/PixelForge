import { applyFilter } from './filters';
import type { FilterRequest } from './filters';

export interface FilterTask extends FilterRequest {
  readonly id: number;
}

export interface FilterResponse {
  readonly id: number;
  readonly pixels: Uint8ClampedArray;
}

self.addEventListener('message', (event: MessageEvent<FilterTask>) => {
  const task = event.data;
  const pixels = applyFilter(task);
  const response: FilterResponse = { id: task.id, pixels };
  (self as unknown as Worker).postMessage(response, [pixels.buffer]);
});
