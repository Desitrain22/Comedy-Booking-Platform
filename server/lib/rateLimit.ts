/**
 * In-memory rate limits for the sign-in endpoints, per IP and per account.
 *
 * Sliding window: a rule allows `limit` hits per `windowMs` for each key; a full key is
 * blocked until its oldest hit leaves the window. The state lives in this process (one Node
 * server, one SQLite file), so a restart clears it — that's fine for slowing down password
 * guessing and email floods. Each app gets its own limiter (keyed by its database), so every
 * `makeTestApp()` starts clean.
 *
 *   const limits = rateLimiter(c.var.db);
 *   const wait = limits.retryAfter([['loginFailuresPerIp', ip], ['loginFailuresPerAccount', email]]);
 *   if (wait) return tooManyRequests(c, wait, 'Too many sign-in attempts');
 *   const undo = limits.hit('loginFailuresPerIp', ip);   // count first (no race), undo on success
 *
 * Memory is bounded per rule (`MAX_KEYS_PER_RULE`). A live key is never dropped to make room:
 * forgetting one would hand its owner a fresh budget, so a flood of throwaway addresses could
 * reset an account's lock or the club-wide email cap. Instead a full rule fails closed — a key
 * it isn't already tracking is answered as limited until stale keys age out.
 *
 * 429 body: `{ error, code: 'rate_limited', retryAfter }` (seconds), plus a `Retry-After` header.
 */
import type { Context } from 'hono';
import type { Db } from '../db/client';

const MINUTE = 60_000;

export interface RateLimitRule {
  /** Hits allowed per window. */
  limit: number;
  windowMs: number;
}

/**
 * Production limits. Generous enough for a club's bookers and comedians sharing one venue
 * Wi-Fi (one IP), tight enough that guessing a password or 6-digit code goes nowhere.
 *
 * Each account's hard lock is per account *and* IP, so a stranger who knows a booker's or
 * comedian's email can only lock themselves out; the looser per-account limit catches
 * guessing spread over many addresses. All of them treat known and unknown emails alike, so
 * a 429 says nothing about who has an account.
 */
export const DEFAULT_RATE_LIMITS = {
  /** Wrong booker passwords from one IP, whatever the account. */
  loginFailuresPerIp: { limit: 30, windowMs: 15 * MINUTE },
  /**
   * Wrong passwords for one booker email from one IP. Once full, even the right password
   * waits on that IP — otherwise the 429 would stop nothing — but the owner signing in from
   * anywhere else isn't held up by someone else's guesses.
   */
  loginFailuresPerAccountIp: { limit: 10, windowMs: 15 * MINUTE },
  /**
   * Wrong passwords for one booker email from every IP together: the backstop for guessing
   * spread over many addresses. Loose, so it takes many addresses to lock the owner out.
   */
  loginFailuresPerAccount: { limit: 100, windowMs: 15 * MINUTE },
  /** Comedian sign-in code requests from one IP (every request counts, known email or not). */
  codeRequestsPerIp: { limit: 20, windowMs: 15 * MINUTE },
  /**
   * Sign-in code emails actually sent, club-wide: a backstop so a flood can't burn the SMTP
   * quota. Only checked when an email would go out; past it the request still gets the usual
   * 200 (nothing is sent), so other people's traffic never turns a sign-in away with a 429.
   */
  codeEmailsGlobal: { limit: 1000, windowMs: 60 * MINUTE },
  /** Wrong sign-in codes from one IP, whatever the email. */
  codeFailuresPerIp: { limit: 50, windowMs: 15 * MINUTE },
  /** Wrong sign-in codes for one email from one IP (the hard lock, like the booker one). */
  codeFailuresPerEmailIp: { limit: 10, windowMs: 15 * MINUTE },
  /**
   * Wrong sign-in codes for one email from every IP together. Loose: the database already
   * caps guesses per comedian (5 codes per 15 minutes, each dead after 5 wrong tries).
   */
  codeFailuresPerEmail: { limit: 100, windowMs: 15 * MINUTE },
  /** Wrong "current password" on Settings → Account, per booker. */
  passwordChangeFailuresPerAccount: { limit: 5, windowMs: 15 * MINUTE },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof DEFAULT_RATE_LIMITS;
export type RateLimitConfig = Record<RateLimitName, RateLimitRule>;

/** `[rule, key]` pairs checked together; the longest wait wins. */
export type RateLimitCheck = readonly [RateLimitName, string];

/** Keys tracked per rule; past this a rule fails closed for keys it isn't tracking yet. */
export const MAX_KEYS_PER_RULE = 50_000;
/** Stale keys are swept every this many hits… */
const SWEEP_EVERY = 1_000;
/** …and when a full rule is asked about a new key, at most this often (a sweep walks every key). */
const FULL_SWEEP_EVERY_MS = 1_000;

/** Combined key for an account-and-IP rule (an IP never contains `|`). */
export function accountIpKey(account: string, ip: string): string {
  return `${ip}|${account}`;
}

/** Every rule scaled by `factor` (at least 1 hit). */
export function scaleRateLimits(config: RateLimitConfig, factor: number): RateLimitConfig {
  const out = {} as Record<RateLimitName, RateLimitRule>;
  for (const [name, rule] of Object.entries(config) as [RateLimitName, RateLimitRule][]) {
    out[name] = { limit: Math.max(1, Math.round(rule.limit * factor)), windowMs: rule.windowMs };
  }
  return out;
}

export class RateLimiter {
  readonly rules: RateLimitConfig;
  private readonly now: () => number;
  private readonly maxKeysPerRule: number;
  /** rule → key → hit times, oldest first, at most `limit` of them. */
  private readonly hits = new Map<RateLimitName, Map<string, number[]>>();
  private sinceSweep = 0;
  private lastSweepAt = -Infinity;

  constructor(
    rules: Partial<RateLimitConfig> = {},
    now: () => number = Date.now,
    maxKeysPerRule: number = MAX_KEYS_PER_RULE,
  ) {
    this.rules = { ...DEFAULT_RATE_LIMITS, ...rules };
    this.now = now;
    this.maxKeysPerRule = maxKeysPerRule;
  }

  private table(name: RateLimitName): Map<string, number[]> {
    let table = this.hits.get(name);
    if (!table) {
      table = new Map();
      this.hits.set(name, table);
    }
    return table;
  }

  private live(name: RateLimitName, key: string): number[] | undefined {
    const table = this.table(name);
    const list = table.get(key);
    if (!list) return undefined;
    const cutoff = this.now() - this.rules[name].windowMs;
    while (list.length && list[0]! <= cutoff) list.shift();
    if (!list.length) {
      table.delete(key);
      return undefined;
    }
    return list;
  }

  /** No room for a new key in this rule, even after dropping stale ones. */
  private isFull(name: RateLimitName): boolean {
    const table = this.table(name);
    if (table.size < this.maxKeysPerRule) return false;
    if (this.now() - this.lastSweepAt >= FULL_SWEEP_EVERY_MS) this.sweep();
    return table.size >= this.maxKeysPerRule;
  }

  /** Seconds until every check has room again; 0 when all are allowed now. */
  retryAfter(checks: readonly RateLimitCheck[]): number {
    let waitMs = 0;
    for (const [name, key] of checks) {
      const { limit, windowMs } = this.rules[name];
      const list = this.live(name, key);
      if (list && list.length >= limit) waitMs = Math.max(waitMs, list[list.length - limit]! + windowMs - this.now());
      // A key we can't track counts as limited (fail closed); room opens within one window.
      else if (!list && this.isFull(name)) waitMs = Math.max(waitMs, windowMs);
    }
    return waitMs > 0 ? Math.max(1, Math.ceil(waitMs / 1000)) : 0;
  }

  /** Record one hit. Returns an undo (e.g. the attempt turned out to be a success). */
  hit(name: RateLimitName, key: string): () => void {
    const at = this.now();
    let list = this.live(name, key);
    if (!list) {
      // Full: `retryAfter` already answers this key as limited, so there's nothing to record.
      if (this.isFull(name)) return () => {};
      list = [];
      this.table(name).set(key, list);
    }
    list.push(at);
    // Only the newest `limit` hits matter for the decision.
    if (list.length > this.rules[name].limit) list.splice(0, list.length - this.rules[name].limit);
    if (++this.sinceSweep >= SWEEP_EVERY) this.sweep();
    return () => {
      const current = this.table(name).get(key);
      const i = current?.lastIndexOf(at) ?? -1;
      if (current && i >= 0) current.splice(i, 1);
    };
  }

  /** Forget a key (e.g. a successful sign-in clears that account's failures). */
  reset(name: RateLimitName, key: string): void {
    this.table(name).delete(key);
  }

  /** Forget everything. */
  clear(): void {
    this.hits.clear();
    this.sinceSweep = 0;
    this.lastSweepAt = -Infinity;
  }

  /** Number of tracked keys (tests, and to check memory stays bounded). */
  get size(): number {
    let size = 0;
    for (const table of this.hits.values()) size += table.size;
    return size;
  }

  /** Drop keys whose hits have all left the window. Live keys are never dropped. */
  private sweep(): void {
    const now = this.now();
    this.sinceSweep = 0;
    this.lastSweepAt = now;
    for (const [name, table] of this.hits) {
      const cutoff = now - this.rules[name].windowMs;
      for (const [key, list] of table) {
        if (!list.length || list[list.length - 1]! <= cutoff) table.delete(key);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// One limiter per app (keyed by its database)
// ---------------------------------------------------------------------------

const limiters = new WeakMap<Db, RateLimiter>();

/** Install the limiter for an app's database (`createApp` does this). */
export function setRateLimiter(db: Db, limiter: RateLimiter): RateLimiter {
  limiters.set(db, limiter);
  return limiter;
}

/** The limiter for this database; a default one is created on first use. */
export function rateLimiter(db: Db): RateLimiter {
  let limiter = limiters.get(db);
  if (!limiter) {
    limiter = new RateLimiter();
    limiters.set(db, limiter);
  }
  return limiter;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** "in 1 minute" / "in 14 minutes" (rounded up). */
export function retryAfterText(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** 429 `{ error: '<what>. Try again in N minutes.', code: 'rate_limited', retryAfter }` + Retry-After. */
export function tooManyRequests(c: Context, retryAfterSeconds: number, what: string): Response {
  c.header('Retry-After', String(retryAfterSeconds));
  return c.json(
    {
      error: `${what}. Try again ${retryAfterText(retryAfterSeconds)}.`,
      code: 'rate_limited',
      retryAfter: retryAfterSeconds,
    },
    429,
  );
}
