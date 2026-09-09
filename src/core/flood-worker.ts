import { growSelection, selectSimilar, wandSelect } from './flood-select';
import type { SeededInput, WandInput } from './flood-select';

export type FloodTask =
  | ({ readonly id: number; readonly kind: 'wand' } & WandInput)
  | ({ readonly id: number; readonly kind: 'similar' | 'grow' } & SeededInput);

export interface FloodResult {
  readonly id: number;
  readonly mask: Uint8ClampedArray;
}

/** Runs a task. Shared by the worker and the inline path so both agree. */
export function runFloodTask(task: FloodTask): Uint8ClampedArray {
  if (task.kind === 'wand') return wandSelect(task);
  if (task.kind === 'similar') return selectSimilar(task);
  return growSelection(task);
}

self.addEventListener('message', (event: MessageEvent<FloodTask>) => {
  const task = event.data;
  const mask = runFloodTask(task);
  const result: FloodResult = { id: task.id, mask };
  (self as unknown as Worker).postMessage(result, [mask.buffer]);
});
