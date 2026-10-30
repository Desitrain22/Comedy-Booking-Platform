import { describe, expect, it } from 'vitest';
import { DEFAULT_RATE_LIMITS, RateLimiter, retryAfterText, scaleRateLimits } from './rateLimit';

function limiter(limit = 3, windowMs = 60_000) {
  const clock = { now: 1_000_000 };
  const l = new RateLimiter({ loginFailuresPerIp: { limit, windowMs } }, () => clock.now);
  return { l, clock };
}

describe('RateLimiter', () => {
  it('allows `limit` hits per window, then says how long to wait (sliding window)', () => {
    const { l, clock } = limiter(3, 60_000);
    const check = () => l.retryAfter([['loginFailuresPerIp', '1.2.3.4']]);
    expect(check()).toBe(0);
    l.hit('loginFailuresPerIp', '1.2.3.4');
    clock.now += 10_000;
    l.hit('loginFailuresPerIp', '1.2.3.4');
    l.hit('loginFailuresPerIp', '1.2.3.4');
    expect(check()).toBe(50); // the first hit leaves the window in 50s
    clock.now += 50_000;
    expect(check()).toBe(0);
    l.hit('loginFailuresPerIp', '1.2.3.4');
    expect(check()).toBe(10); // now the two hits at +10s are the oldest that matter
  });

  it('keeps keys and rules apart, and the longest wait wins', () => {
    const { l } = limiter(1, 60_000);
    l.hit('loginFailuresPerIp', 'a');
    expect(l.retryAfter([['loginFailuresPerIp', 'b']])).toBe(0);
    expect(l.retryAfter([['loginFailuresPerAccount', 'a']])).toBe(0);
    expect(l.retryAfter([['loginFailuresPerAccount', 'a'], ['loginFailuresPerIp', 'a']])).toBe(60);
  });

  it('undoes a hit and resets a key', () => {
    const { l } = limiter(2);
    const undo = l.hit('loginFailuresPerIp', 'a');
    l.hit('loginFailuresPerIp', 'a');
    expect(l.retryAfter([['loginFailuresPerIp', 'a']])).toBeGreaterThan(0);
    undo();
    expect(l.retryAfter([['loginFailuresPerIp', 'a']])).toBe(0);
    l.hit('loginFailuresPerIp', 'a');
    l.reset('loginFailuresPerIp', 'a');
    expect(l.retryAfter([['loginFailuresPerIp', 'a']])).toBe(0);
    expect(l.size).toBe(0);
  });

  it('stores at most `limit` timestamps per key and forgets stale keys', () => {
    const { l, clock } = limiter(3, 1_000);
    for (let i = 0; i < 100; i++) l.hit('loginFailuresPerIp', 'flood');
    expect(l.retryAfter([['loginFailuresPerIp', 'flood']])).toBe(1);
    for (let i = 0; i < 2_000; i++) l.hit('loginFailuresPerIp', `ip-${i}`);
    clock.now += 2_000;
    // The periodic sweep (every 1,000 hits) drops keys whose hits all aged out.
    for (let i = 0; i < 1_000; i++) l.hit('loginFailuresPerIp', 'fresh');
    expect(l.size).toBe(1);
  });

  it('never forgets a live key to make room: a full rule refuses keys it isn\'t tracking (fail closed)', () => {
    const clock = { now: 1_000_000 };
    const l = new RateLimiter(
      {
        loginFailuresPerAccount: { limit: 2, windowMs: 60_000 },
        codeEmailsGlobal: { limit: 2, windowMs: 60_000 },
        codeFailuresPerIp: { limit: 5, windowMs: 60_000 },
      },
      () => clock.now,
      3, // keys per rule
    );
    // A locked account and a spent club-wide cap…
    l.hit('loginFailuresPerAccount', 'admin@club.test');
    l.hit('loginFailuresPerAccount', 'admin@club.test');
    l.hit('codeEmailsGlobal', 'all');
    l.hit('codeEmailsGlobal', 'all');
    // …then a flood of fresh addresses, far past the cap (hit without asking first, too).
    for (let i = 0; i < 5_000; i++) l.hit('codeFailuresPerIp', `ip-${i}`);
    for (let i = 0; i < 1_000; i++) l.hit('codeFailuresPerIp', 'ip-0');
    expect(l.retryAfter([['loginFailuresPerAccount', 'admin@club.test']])).toBe(60);
    expect(l.retryAfter([['codeEmailsGlobal', 'all']])).toBe(60);
    expect(l.size).toBe(2 + 3);

    // The addresses it was already tracking keep their own counts…
    expect(l.retryAfter([['codeFailuresPerIp', 'ip-0']])).toBe(60);
    expect(l.retryAfter([['codeFailuresPerIp', 'ip-1']])).toBe(0);
    // …and a new one is turned away for a window instead of pushing anyone out.
    expect(l.retryAfter([['codeFailuresPerIp', 'ip-new']])).toBe(60);

    // Per-account keys are capped the same way: existing ones work, a new one waits.
    l.hit('loginFailuresPerAccount', 'b@club.test');
    l.hit('loginFailuresPerAccount', 'c@club.test');
    l.hit('loginFailuresPerAccount', 'd@club.test');
    expect(l.retryAfter([['loginFailuresPerAccount', 'b@club.test']])).toBe(0);
    expect(l.retryAfter([['loginFailuresPerAccount', 'd@club.test']])).toBe(60);
    expect(l.size).toBe(3 + 1 + 3);

    // Once the flood ages out there's room again.
    clock.now += 60_001;
    expect(l.retryAfter([['codeFailuresPerIp', 'ip-new']])).toBe(0);
    expect(l.retryAfter([['loginFailuresPerAccount', 'd@club.test']])).toBe(0);
    expect(l.size).toBe(0);
  });

  it('scales limits (dev servers get 10× headroom) and words the wait', () => {
    const scaled = scaleRateLimits(DEFAULT_RATE_LIMITS, 10);
    expect(scaled.loginFailuresPerAccount).toEqual({
      limit: DEFAULT_RATE_LIMITS.loginFailuresPerAccount.limit * 10,
      windowMs: DEFAULT_RATE_LIMITS.loginFailuresPerAccount.windowMs,
    });
    expect(retryAfterText(1)).toBe('in 1 minute');
    expect(retryAfterText(60)).toBe('in 1 minute');
    expect(retryAfterText(61)).toBe('in 2 minutes');
    expect(retryAfterText(900)).toBe('in 15 minutes');
  });
});
