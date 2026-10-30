/**
 * Platform-host API (hosted mode; shapes in shared/api/platform.ts). Mounted at `/api` by
 * createApp; the tenancy middleware only lets platform-host requests reach it.
 *
 *   GET  /api/platform/slug?slug=…     is this address free?
 *   POST /api/platform/signup          create a club → { clubUrl, handoffUrl }
 *   POST /api/platform/find-club       email the clubs this address belongs to (always ok)
 *
 * Sign-up: SIGNUPS=closed → 403 `signups_closed`; 5 per IP per hour (429); a filled honeypot
 * → 400 `signup_rejected`, nothing created. It registers the club, creates its database,
 * runs the same setup as `/api/setup` (server/services/setup.ts) with the app URL set to the
 * club's address, emails each PLATFORM_ADMIN_EMAILS address, and hands back a one-time
 * handoff URL (server/platform/handoffs.ts) that signs the new booker in on the club host.
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  findClubSchema,
  signupSchema,
  slugSchema,
  type SignupResponse,
  type SlugCheckResponse,
} from '../../shared/api/platform';
import type { OkResponse } from '../../shared/types';
import { hashPassword } from '../auth/password';
import { clientIp } from '../auth/request';
import type { AppEnv } from '../context';
import { comedians, users } from '../db/schema';
import { env } from '../env';
import { jsonError } from '../lib/http';
import { tooManyRequests } from '../lib/rateLimit';
import { getSettings } from '../lib/settings';
import { validate } from '../lib/validate';
import { applyClubSetup } from '../services/setup';
import { findClubEmail, signupNoticeEmail, type FoundClub } from './emails';
import { createHandoff, handoffUrl } from './handoffs';
import { clubHost } from './hosts';
import type { Platform } from './index';
import { SlugTakenError } from './registry';

const SLUG_TAKEN = 'That address is taken';

/** Is this slug free? Format and reserved words first, then the registry (any status). */
export function checkSlug(platform: Platform, raw: string): SlugCheckResponse {
  const parsed = slugSchema.safeParse(raw);
  const slug = raw.trim().toLowerCase();
  if (!parsed.success) return { slug, available: false, reason: parsed.error.issues[0]?.message ?? 'Invalid address' };
  if (platform.registry.getClubBySlug(parsed.data)) return { slug: parsed.data, available: false, reason: SLUG_TAKEN };
  return { slug: parsed.data, available: true };
}

/** Active clubs where `email` is a booker (with a password) or an active comedian. */
export function findClubsFor(platform: Platform, email: string): FoundClub[] {
  const found: FoundClub[] = [];
  for (const club of platform.registry.listClubs({ status: 'active' })) {
    try {
      const db = platform.registry.openClubDb(club);
      const booker = db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, email), isNotNull(users.passwordHash)))
        .get();
      const comedian = db
        .select({ id: comedians.id })
        .from(comedians)
        .where(and(eq(comedians.email, email), eq(comedians.archived, false)))
        .get();
      if (booker || comedian) {
        found.push({
          clubName: getSettings(db).clubName || club.name,
          clubUrl: platform.registry.clubUrl(club),
          booker: Boolean(booker),
          comedian: Boolean(comedian),
        });
      }
    } catch (err) {
      console.error(`[find-club] could not search club ${club.slug}`, err);
    }
  }
  return found;
}

export function platformRoutes(platform: Platform): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const { hosted, registry, limiter, mailer } = platform;

  routes.get('/platform/slug', validate('query', z.object({ slug: z.string().max(200).default('') })), (c) =>
    c.json(checkSlug(platform, c.req.valid('query').slug)),
  );

  routes.post(
    '/platform/signup',
    (c, next) => {
      if (!hosted.signupsOpen) {
        return jsonError(c, 403, 'Sign-ups are closed right now', 'signups_closed', {
          supportEmail: hosted.supportEmail,
        });
      }
      const wait = limiter.retryAfter([['signupsPerIp', clientIp(c)]]);
      if (wait) return tooManyRequests(c, wait, 'Too many sign-ups from your network');
      return next();
    },
    validate('json', signupSchema),
    async (c) => {
      const input = c.req.valid('json');
      const ip = clientIp(c);
      const undoHit = limiter.hit('signupsPerIp', ip);
      // Bots fill every field; the form hides this one from people.
      if (input.website?.trim()) {
        return jsonError(c, 400, "We couldn't create your club. Please try again.", 'signup_rejected');
      }
      const slugTaken = () => {
        undoHit();
        return jsonError(c, 409, SLUG_TAKEN, 'slug_taken', { issues: [{ path: 'slug', message: SLUG_TAKEN }] });
      };
      if (registry.getClubBySlug(input.slug)) return slugTaken();

      const passwordHash = await hashPassword(input.admin.password);
      const url = registry.clubUrl({ slug: input.slug });
      let created;
      try {
        created = registry.createClub(
          { slug: input.slug, name: input.clubName, ownerName: input.admin.name, ownerEmail: input.admin.email },
          (db) =>
            applyClubSetup(db, {
              clubName: input.clubName,
              timezone: input.timezone,
              appUrl: url,
              location: input.location,
              admin: { name: input.admin.name, email: input.admin.email, passwordHash },
            }),
        );
      } catch (err) {
        if (err instanceof SlugTakenError) return slugTaken();
        undoHit();
        throw err;
      }
      const { club, result: admin } = created;

      for (const to of hosted.adminEmails) {
        const content = signupNoticeEmail({
          platformName: hosted.platformName,
          platformUrl: hosted.platformUrl,
          clubName: club.name,
          clubHost: clubHost(hosted, club.slug),
          clubUrl: url,
          ownerName: club.ownerName,
          ownerEmail: club.ownerEmail,
          timezone: input.timezone,
          locationName: input.location.name,
        });
        void mailer.send({ to, kind: 'signup_notice', ...content });
      }
      if (!env.isTest) console.log(`[platform] New club: ${club.name} (${url}), ${club.ownerName} <${club.ownerEmail}>`);

      const token = createHandoff(platform.db, club.id, admin.id);
      const body: SignupResponse = { clubUrl: url, handoffUrl: handoffUrl(url, token) };
      return c.json(body, 201);
    },
  );

  routes.post('/platform/find-club', validate('json', findClubSchema), (c) => {
    const { email } = c.req.valid('json');
    const ip = clientIp(c);
    const wait = limiter.retryAfter([['findClubPerIp', ip]]);
    if (wait) return tooManyRequests(c, wait, 'Too many requests');
    limiter.hit('findClubPerIp', ip);

    // The same answer whatever we find (or whether this address is over its limit), and the
    // email goes out in the background, so the response says nothing about who has an account.
    if (!limiter.retryAfter([['findClubEmailsPerAddress', email]])) {
      const clubs = findClubsFor(platform, email);
      if (clubs.length) {
        limiter.hit('findClubEmailsPerAddress', email);
        const content = findClubEmail({ platformName: hosted.platformName, email, clubs });
        void mailer.send({ to: email, kind: 'find_club', ...content });
      }
    }
    return c.json({ ok: true } satisfies OkResponse);
  });

  return routes;
}
