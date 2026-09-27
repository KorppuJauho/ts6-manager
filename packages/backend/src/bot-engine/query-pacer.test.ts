import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryPacer } from './query-pacer.js';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/** Takes `n` slots and records when (in fake ms) each was granted. */
async function grantTimes(pacer: QueryPacer, n: number, runFor: number): Promise<number[]> {
  const start = Date.now();
  const times: number[] = [];
  for (let i = 0; i < n; i++) pacer.take().then(() => times.push(Date.now() - start));
  await vi.advanceTimersByTimeAsync(runFor);
  return times;
}

describe('QueryPacer', () => {
  it('lets a burst up to the limit through at once', async () => {
    const times = await grantTimes(new QueryPacer(5, 3000), 5, 0);
    expect(times).toEqual([0, 0, 0, 0, 0]);
  });

  it('holds the rest until the window has room again', async () => {
    const times = await grantTimes(new QueryPacer(5, 3000), 12, 10_000);
    expect(times).toEqual([0, 0, 0, 0, 0, 3000, 3000, 3000, 3000, 3000, 6000, 6000]);
  });

  it('never lets more than the limit through in any window', async () => {
    const times = await grantTimes(new QueryPacer(5, 3000), 40, 60_000);
    expect(times).toHaveLength(40);
    for (const t of times) {
      expect(times.filter((u) => u >= t && u < t + 3000).length).toBeLessThanOrEqual(5);
    }
  });

  it('serves callers in the order they asked', async () => {
    const pacer = new QueryPacer(1, 1000);
    const order: string[] = [];
    pacer.take().then(() => order.push('a'));
    pacer.take().then(() => order.push('b'));
    pacer.take().then(() => order.push('c'));
    await vi.advanceTimersByTimeAsync(3000);
    expect(order).toEqual(['a', 'b', 'c']);
  });
});
