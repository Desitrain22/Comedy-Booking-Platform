/**
 * Platform-level rate limits (hosted mode): sign-up and "find my club" on the platform host.
 * Same sliding-window machinery as the clubs' sign-in limits (server/lib/rateLimit.ts), in a
 * limiter of its own that lives with the Platform (one per server, not per club database).
 *
 *   const wait = platform.limiter.retryAfter([['signupsPerIp', ip]]);
 *   if (wait) return tooManyRequests(c, wait, 'Too many sign-ups from your network');
 *   const undo = platform.limiter.hit('signupsPerIp', ip);
 */
import { RateLimiter, scaleRateLimits, type RateLimitConfig, type RateLimitRule } from '../lib/rateLimit';
import { DEV_RATE_LIMIT_FACTOR, isDevServer } from '../lib/rateLimitConfig';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const PLATFORM_RATE_LIMITS = {
  /** Clubs created (or honeypot hits) from one IP. */
  signupsPerIp: { limit: 5, windowMs: HOUR },
  /** "Find my club" requests from one IP (every request counts). Past it: 429. */
  findClubPerIp: { limit: 20, windowMs: HOUR },
  /**
   * "Find my club" emails to one address. Past it the request still answers ok but nothing
   * is sent, so a stranger can't flood someone's inbox, and the answer never says whether the
   * address has an account.
   */
  findClubEmailsPerAddress: { limit: 3, windowMs: HOUR },
} as const satisfies Record<string, RateLimitRule>;

export type PlatformRateLimitName = keyof typeof PLATFORM_RATE_LIMITS;
export type PlatformRateLimitConfig = Record<PlatformRateLimitName, RateLimitRule>;
export type PlatformRateLimitCheck = readonly [PlatformRateLimitName, string];

/** Production limits, ×10 on a dev server (like the clubs' sign-in limits), plus overrides. */
export function resolvePlatformRateLimits(overrides: Partial<PlatformRateLimitConfig> = {}): PlatformRateLimitConfig {
  const base: PlatformRateLimitConfig = isDevServer()
    ? (scaleRateLimits(PLATFORM_RATE_LIMITS as unknown as RateLimitConfig, DEV_RATE_LIMIT_FACTOR) as unknown as PlatformRateLimitConfig)
    : PLATFORM_RATE_LIMITS;
  return { ...base, ...overrides };
}

/**
 * A RateLimiter keyed by the platform's rule names. RateLimiter's rule names are the clubs'
 * (a closed union); at runtime it reads any rule it was given, so this wrapper only narrows
 * the names to the platform's own.
 */
export class PlatformRateLimiter {
  private readonly inner: RateLimiter;
  readonly rules: PlatformRateLimitConfig;

  constructor(rules: Partial<PlatformRateLimitConfig> = {}, now?: () => number) {
    this.rules = resolvePlatformRateLimits(rules);
    this.inner = new RateLimiter(this.rules as unknown as Partial<RateLimitConfig>, now);
  }

  /** Seconds until every check has room again; 0 when all are allowed now. */
  retryAfter(checks: readonly PlatformRateLimitCheck[]): number {
    return this.inner.retryAfter(checks as unknown as Parameters<RateLimiter['retryAfter']>[0]);
  }

  /** Record one hit. Returns an undo. */
  hit(name: PlatformRateLimitName, key: string): () => void {
    return this.inner.hit(name as unknown as Parameters<RateLimiter['hit']>[0], key);
  }

  reset(name: PlatformRateLimitName, key: string): void {
    this.inner.reset(name as unknown as Parameters<RateLimiter['reset']>[0], key);
  }

  clear(): void {
    this.inner.clear();
  }
}
