/** Small helpers for sending batches of emails. */

/** How many emails a blast sends at once (gentle on SMTP providers). */
export const EMAIL_CONCURRENCY = 3;

/** `Promise.all(items.map(fn))` with at most `limit` calls in flight; results keep input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, worker));
  return results;
}
