/**
 * Owner console API (hosted MVP spec §6; shapes in shared/api/platformAdmin.ts). Mounted at
 * `/api` by createApp in hosted mode; the tenancy middleware only lets platform-host requests
 * reach `/api/platform/*`, so club hosts get 404 `not_found`.
 *
 *   POST /api/platform/admin/request-code       always ok; a code only goes to a listed owner
 *   POST /api/platform/admin/verify-code        → session cookie (7 days)
 *   GET  /api/platform/admin/me                 { admin: { email } | null }
 *   POST /api/platform/admin/logout
 *
 * Sign-in is rate limited per IP and per email (server/platform/limits.ts). An address that
 * isn't an owner's gets the same answers as one that is (no email, and its codes never work).
 */
import { Hono } from 'hono';
import { adminRequestCodeSchema, adminVerifyCodeSchema, type AdminMeResponse } from '../../shared/api/platformAdmin';
import type { OkResponse } from '../../shared/types';
import { clientIp } from '../auth/request';
import type { AppEnv } from '../context';
import { env } from '../env';
import { jsonError } from '../lib/http';
import { isDevServer } from '../lib/rateLimitConfig';
import { tooManyRequests } from '../lib/rateLimit';
import { validate } from '../lib/validate';
import {
  adminLoginCodeEmail,
  endAdminSession,
  getPlatformAdmin,
  isPlatformAdminEmail,
  issueAdminCode,
  startAdminSession,
  verifyAdminCode,
} from './adminAuth';
import type { Platform } from './index';

export function platformAdminRoutes(platform: Platform): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const { hosted, limiter, mailer } = platform;

  // -------------------------------------------------------------------------
  // Sign-in
  // -------------------------------------------------------------------------

  routes.post('/platform/admin/request-code', validate('json', adminRequestCodeSchema), (c) => {
    const { email } = c.req.valid('json');
    const ip = clientIp(c);
    const wait = limiter.retryAfter([['adminCodeRequestsPerIp', ip]]);
    if (wait) return tooManyRequests(c, wait, 'Too many sign-in code requests');
    limiter.hit('adminCodeRequestsPerIp', ip);

    // The same answer for every address (and whether or not this one is over its limit); the
    // email goes out in the background, so the response says nothing about who is an owner.
    if (isPlatformAdminEmail(hosted, email) && !limiter.retryAfter([['adminCodeEmailsPerAddress', email]])) {
      limiter.hit('adminCodeEmailsPerAddress', email);
      const { code } = issueAdminCode(platform.db, email);
      const content = adminLoginCodeEmail({
        platformName: hosted.platformName,
        code,
        consoleUrl: `${hosted.platformUrl}/admin`,
      });
      void mailer.send({ to: email, kind: 'admin_login_code', ...content });
      if (isDevServer()) console.log(`[owner-console] sign-in code for ${email}: ${code}`);
    }
    return c.json({ ok: true } satisfies OkResponse);
  });

  routes.post('/platform/admin/verify-code', validate('json', adminVerifyCodeSchema), (c) => {
    const { email, code } = c.req.valid('json');
    const ip = clientIp(c);
    const wait = limiter.retryAfter([
      ['adminCodeFailuresPerIp', ip],
      ['adminCodeFailuresPerEmail', email],
    ]);
    if (wait) return tooManyRequests(c, wait, 'Too many wrong codes');
    // Counted before checking (no race); a success takes it back.
    const undoIp = limiter.hit('adminCodeFailuresPerIp', ip);
    const undoEmail = limiter.hit('adminCodeFailuresPerEmail', email);

    const result = isPlatformAdminEmail(hosted, email) ? verifyAdminCode(platform.db, email, code) : 'invalid';
    // A code dead after 5 wrong tries answers like any wrong code.
    if (result !== 'ok') return jsonError(c, 400, "That code isn't right or has expired", 'invalid_code');
    undoIp();
    undoEmail();
    const admin = startAdminSession(c, platform, email);
    if (!env.isTest) console.log(`[owner-console] ${email} signed in`);
    return c.json({ admin } satisfies AdminMeResponse);
  });

  routes.get('/platform/admin/me', (c) => c.json({ admin: getPlatformAdmin(c, platform) } satisfies AdminMeResponse));

  routes.post('/platform/admin/logout', (c) => {
    endAdminSession(c, platform);
    return c.json({ ok: true } satisfies OkResponse);
  });

  return routes;
}
