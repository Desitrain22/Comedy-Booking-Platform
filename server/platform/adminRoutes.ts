/**
 * Owner console API (hosted MVP spec §6; shapes in shared/api/platformAdmin.ts). Mounted at
 * `/api` by createApp in hosted mode; the tenancy middleware only lets platform-host requests
 * reach `/api/platform/*`, so club hosts get 404 `not_found`.
 *
 *   POST /api/platform/admin/request-code       always ok; a code only goes to a listed owner
 *   POST /api/platform/admin/verify-code        → session cookie (7 days)
 *   GET  /api/platform/admin/me                 { admin: { email } | null }
 *   POST /api/platform/admin/logout
 *   GET  /api/platform/admin/overview           totals + clubs (?status=active|suspended|archived|all&search=)
 *   GET  /api/platform/admin/clubs/:id          one club in depth
 *   POST /api/platform/admin/clubs/:id/suspend | reactivate | archive | restore
 *   GET  /api/platform/admin/clubs/:id/backup   the club's database as a .db download
 *
 * Sign-in is rate limited per IP and per email (server/platform/limits.ts). An address that
 * isn't an owner's gets the same answers as one that is (no email, and its codes never work).
 */
import { Hono } from 'hono';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import {
  adminArchiveSchema,
  adminEmptySchema,
  adminOverviewQuerySchema,
  adminRequestCodeSchema,
  adminSuspendSchema,
  adminVerifyCodeSchema,
  type AdminActionResponse,
  type AdminClubDetail,
  type AdminMeResponse,
  type AdminOverview,
} from '../../shared/api/platformAdmin';
import type { OkResponse } from '../../shared/types';
import { clientIp } from '../auth/request';
import type { AppEnv } from '../context';
import { env } from '../env';
import { jsonError, parseId } from '../lib/http';
import { isDevServer } from '../lib/rateLimitConfig';
import { tooManyRequests } from '../lib/rateLimit';
import { validate } from '../lib/validate';
import { changeClubStatus, findClubOr404, recordAdminEvent, snapshotClubDb, type StatusAction } from './adminActions';
import {
  adminLoginCodeEmail,
  endAdminSession,
  getPlatformAdmin,
  isPlatformAdminEmail,
  issueAdminCode,
  requirePlatformAdmin,
  startAdminSession,
  verifyAdminCode,
} from './adminAuth';
import { buildAdminClubDetail, buildAdminOverview, readClub, toAdminClubRow } from './adminStats';
import type { Platform } from './index';
import type { Club } from './schema';

/** Safety net: remove a backup temp file even if the download is never read. */
const BACKUP_TEMP_TTL_MS = 10 * 60_000;

export function platformAdminRoutes(platform: Platform): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const { hosted, limiter, mailer } = platform;
  const requireOwner = requirePlatformAdmin(platform);

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

  // -------------------------------------------------------------------------
  // Overview & club detail
  // -------------------------------------------------------------------------

  routes.get('/platform/admin/overview', requireOwner, validate('query', adminOverviewQuerySchema), (c) => {
    const { status, search } = c.req.valid('query');
    return c.json(buildAdminOverview(platform, { status, search }) satisfies AdminOverview);
  });

  routes.get('/platform/admin/clubs/:id', requireOwner, (c) => {
    const club = findClubOr404(platform, parseId(c.req.param('id')));
    return c.json(buildAdminClubDetail(platform, club) satisfies AdminClubDetail);
  });

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const actionResponse = (club: Club): AdminActionResponse => ({
    club: toAdminClubRow(platform, club, readClub(platform, club)),
  });

  routes.post('/platform/admin/clubs/:id/suspend', requireOwner, validate('json', adminSuspendSchema), (c) => {
    const club = changeClubStatus(platform, {
      clubId: parseId(c.req.param('id')),
      action: 'suspend',
      adminEmail: c.var.platformAdmin.email,
      reason: c.req.valid('json').reason,
    });
    return c.json(actionResponse(club));
  });

  for (const action of ['reactivate', 'restore'] as const satisfies readonly StatusAction[]) {
    routes.post(`/platform/admin/clubs/:id/${action}`, requireOwner, validate('json', adminEmptySchema), (c) => {
      const club = changeClubStatus(platform, {
        clubId: parseId(c.req.param('id')),
        action,
        adminEmail: c.var.platformAdmin.email,
      });
      return c.json(actionResponse(club));
    });
  }

  routes.post('/platform/admin/clubs/:id/archive', requireOwner, validate('json', adminArchiveSchema), (c) => {
    const target = findClubOr404(platform, parseId(c.req.param('id')));
    const { confirmSlug, reason } = c.req.valid('json');
    if (confirmSlug !== target.slug) {
      const message = `Type ${target.slug} to confirm`;
      return jsonError(c, 400, message, 'confirm_slug_mismatch', { issues: [{ path: 'confirmSlug', message }] });
    }
    const club = changeClubStatus(platform, {
      clubId: target.id,
      action: 'archive',
      adminEmail: c.var.platformAdmin.email,
      reason,
    });
    return c.json(actionResponse(club));
  });

  routes.get('/platform/admin/clubs/:id/backup', requireOwner, async (c) => {
    const club = findClubOr404(platform, parseId(c.req.param('id')));
    const snapshot = await snapshotClubDb(platform, club);
    recordAdminEvent(platform.db, { adminEmail: c.var.platformAdmin.email, clubId: club.id, action: 'backup_download' });

    const stream = createReadStream(snapshot.file);
    stream.once('close', snapshot.cleanup);
    setTimeout(snapshot.cleanup, BACKUP_TEMP_TTL_MS).unref();
    const filename = `${club.slug}-backup-${new Date().toISOString().slice(0, 10)}.db`;
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, {
      headers: {
        'content-type': 'application/vnd.sqlite3',
        'content-length': String(snapshot.size),
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
      },
    });
  });

  return routes;
}
