/**
 * Hosted-mode tenancy middleware (hosted MVP spec §3), mounted on `/api/*` by createApp:
 *
 *   /api/health                      any host: ok (load balancer health checks)
 *   /api/host                        any host: HostContext, or 404 `club_not_found`
 *   platform host (<domain>, www.)   /api/platform/* only; anything else 404 `not_found`
 *   active club (<slug>.<domain>)    c.var.db = its database, c.var.club = its row; every
 *                                    club route runs; /api/platform/* 404 `not_found`
 *   suspended club                   403 `club_suspended`
 *   unknown / archived slug, other   404 `club_not_found`
 *
 * The club row is read on every request, so suspending or archiving takes effect at once.
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { ClubNotFoundBody, ClubSuspendedBody, HostContext } from '../../shared/api/platform';
import type { AppEnv } from '../context';
import { jsonError } from '../lib/http';
import { getSettings } from '../lib/settings';
import { matchHost, requestHost } from './hosts';
import type { Platform } from './index';
import type { Club } from './schema';

export type ResolvedHost =
  | { kind: 'platform' }
  /** An active or suspended club (never archived). */
  | { kind: 'club'; club: Club }
  /** No club here: an unknown or archived slug, or a host that isn't ours. */
  | { kind: 'none' };

/** Which site this request URL is for (reads the registry for a club host). */
export function resolveHost(platform: Platform, url: string): ResolvedHost {
  const match = matchHost(platform.hosted, requestHost(url));
  if (match.kind === 'platform') return { kind: 'platform' };
  if (match.kind !== 'club') return { kind: 'none' };
  const club = platform.registry.getClubBySlug(match.slug);
  if (!club || club.status === 'archived') return { kind: 'none' };
  return { kind: 'club', club };
}

export function clubNotFound(c: Context, platform: Platform): Response {
  const body: ClubNotFoundBody = {
    error: "There's no club at this address",
    code: 'club_not_found',
    platformName: platform.hosted.platformName,
    platformUrl: platform.hosted.platformUrl,
  };
  return c.json(body, 404);
}

export function clubSuspended(c: Context, platform: Platform): Response {
  const body: ClubSuspendedBody = {
    error: 'This account is paused',
    code: 'club_suspended',
    supportEmail: platform.hosted.supportEmail,
  };
  return c.json(body, 403);
}

/** `GET /api/host` in hosted mode. */
export function hostContext(c: Context, platform: Platform, host: ResolvedHost): Response {
  const { hosted } = platform;
  if (host.kind === 'none') return clubNotFound(c, platform);
  if (host.kind === 'platform') {
    const body: HostContext = {
      mode: 'platform',
      platformName: hosted.platformName,
      platformUrl: hosted.platformUrl,
      signupsOpen: hosted.signupsOpen,
      supportEmail: hosted.supportEmail,
    };
    return c.json(body);
  }
  const { club } = host;
  let clubName = club.name;
  try {
    clubName = getSettings(platform.registry.openClubDb(club)).clubName || club.name;
  } catch (err) {
    console.error(`[host] could not open the database of club ${club.slug}`, err);
  }
  const body: HostContext = {
    mode: 'club',
    status: club.status === 'suspended' ? 'suspended' : 'active',
    clubName,
    platformName: hosted.platformName,
    platformUrl: hosted.platformUrl,
    supportEmail: hosted.supportEmail,
  };
  return c.json(body);
}

const isPlatformApi = (path: string) => path === '/api/platform' || path.startsWith('/api/platform/');

export function hostedTenancy(platform: Platform): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set('platform', platform);
    const path = c.req.path;
    if (path === '/api/health') return next();

    const host = resolveHost(platform, c.req.url);
    if (path === '/api/host' && (c.req.method === 'GET' || c.req.method === 'HEAD')) {
      return hostContext(c, platform, host);
    }

    if (host.kind === 'none') return clubNotFound(c, platform);
    if (host.kind === 'platform') {
      if (isPlatformApi(path)) return next();
      return jsonError(c, 404, 'Not found', 'not_found');
    }

    const { club } = host;
    if (club.status !== 'active') return clubSuspended(c, platform);
    if (isPlatformApi(path)) return jsonError(c, 404, 'Not found', 'not_found');
    c.set('club', club);
    // Its app address can't be changed: PUT /api/settings refuses (app_url_locked,
    // server/routes/settings.ts), going by the hosting info the registry tags this db with.
    c.set('db', platform.registry.openClubDb(club));
    return next();
  };
}
