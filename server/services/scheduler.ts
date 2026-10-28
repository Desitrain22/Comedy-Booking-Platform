/**
 * Background scheduler (F5-owned; foundation ships this no-op).
 *
 * F5 implements: every 60s (unref'd interval) send the weekly confirmations when
 * confirmationsEnabled and the club-local weekday/time has arrived (idempotent via
 * job_runs `confirmations:<weekStart>`), plus daily cleanup of expired sessions,
 * codes and tokens (see deleteExpiredSessions / deleteStaleLoginCodes /
 * deleteExpiredTokens in server/auth).
 */
import type { Db } from '../db/client';

/** Start background jobs. Returns a function that stops them. */
export function startScheduler(_db: Db): () => void {
  return () => {};
}
