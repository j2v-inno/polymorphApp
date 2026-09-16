import type { UwbeResult } from '../types.js';

/**
 * uw-be calls can fail transiently on RND in ways a single request can't
 * reliably wait out (see batch-split.ts's module doc for the two confirmed
 * failure modes — a request that reaches uw-be and still fails, and one that
 * never reaches it at all). Retry a fixed number of times with a fixed delay
 * before giving up. Shared by anything that iterates many uw-be calls in one
 * run (batch-split, bulk-registration).
 */
export async function tryUwbe<T>(fn: () => Promise<UwbeResult<T>>, attempts = 3, delayMs = 1500): Promise<UwbeResult<T>> {
  let result = await fn();
  for (let attempt = 1; attempt < attempts && !result.ok; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    result = await fn();
  }
  return result;
}
