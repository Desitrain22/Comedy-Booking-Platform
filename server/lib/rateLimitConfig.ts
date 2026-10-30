/**
 * The sign-in rate limits an app (single mode) or each club database (hosted mode) runs with:
 * the production limits (server/lib/rateLimit.ts), ×10 under `npm run dev` so repeated e2e
 * runs against one dev server never trip them.
 */
import { env } from '../env';
import { DEFAULT_RATE_LIMITS, scaleRateLimits, type RateLimitConfig } from './rateLimit';

/** Dev servers (not production, not tests) get every limit ×10. */
export const DEV_RATE_LIMIT_FACTOR = 10;

export function isDevServer(): boolean {
  return !env.isProduction && !env.isTest;
}

export function resolveRateLimits(overrides: Partial<RateLimitConfig> = {}): RateLimitConfig {
  const base = isDevServer() ? scaleRateLimits(DEFAULT_RATE_LIMITS, DEV_RATE_LIMIT_FACTOR) : DEFAULT_RATE_LIMITS;
  return { ...base, ...overrides };
}
