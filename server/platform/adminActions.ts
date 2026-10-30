/**
 * Owner-console actions (hosted MVP spec §6). Each one is written to `admin_events`
 * (who, what, when, why) together with the status change, in one platform.db transaction.
 *
 *   changeClubStatus(platform, { clubId, action: 'suspend', adminEmail, reason });
 *   const snap = await snapshotClubDb(platform, club);   // VACUUM INTO a temp file
 *
 *   suspend     active               → suspended   (optional reason, seen only in the console)
 *   reactivate  suspended            → active
 *   archive     active | suspended   → archived    (closes the club's database; slug stays taken)
 *   restore     archived             → active
 *
 * Anything else is 409 `invalid_transition` (the body carries the club's `status`). The
 * archive route also asks for the club's address typed out (`confirmSlug`).
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { httpError } from '../lib/http';
import { withReadOnlyClubDb } from './adminStats';
import type { Platform } from './index';
import type { PlatformDb } from './db';
import { adminEvents, type AdminAction, type Club, type ClubStatus } from './schema';

export type StatusAction = Exclude<AdminAction, 'backup_download'>;

const TRANSITIONS: Record<StatusAction, { from: readonly ClubStatus[]; to: ClubStatus }> = {
  suspend: { from: ['active'], to: 'suspended' },
  reactivate: { from: ['suspended'], to: 'active' },
  archive: { from: ['active', 'suspended'], to: 'archived' },
  restore: { from: ['archived'], to: 'active' },
};

/** Why `action` doesn't apply to a club in `status`. */
function refusal(action: StatusAction, status: ClubStatus): string {
  if (status === 'archived') {
    if (action === 'archive') return 'This club is already archived.';
    return 'This club is archived. Restore it first.';
  }
  switch (action) {
    case 'suspend':
      return 'This club is already suspended.';
    case 'reactivate':
      return 'This club is already active.';
    case 'restore':
      return "This club isn't archived.";
    default:
      return "That can't be done to this club right now.";
  }
}

export function recordAdminEvent(
  db: PlatformDb,
  event: { adminEmail: string; clubId: number; action: AdminAction; reason?: string; now?: number },
): void {
  db.insert(adminEvents)
    .values({
      adminEmail: event.adminEmail,
      clubId: event.clubId,
      action: event.action,
      reason: event.reason ?? '',
      createdAt: event.now ?? Date.now(),
    })
    .run();
}

/** The club, or 404 `not_found`. */
export function findClubOr404(platform: Platform, id: number): Club {
  const club = platform.registry.getClubById(id);
  if (!club) throw httpError(404, 'Club not found', 'not_found');
  return club;
}

/**
 * Apply a status action and log it. Throws 404 `not_found` (no such club) or 409
 * `invalid_transition`. A suspend/archive reason is kept on the club (shown in the console);
 * reactivating or restoring clears it.
 */
export function changeClubStatus(
  platform: Platform,
  input: { clubId: number; action: StatusAction; adminEmail: string; reason?: string },
): Club {
  const club = findClubOr404(platform, input.clubId);
  const { from, to } = TRANSITIONS[input.action];
  if (!from.includes(club.status)) {
    throw httpError(409, refusal(input.action, club.status), 'invalid_transition', { status: club.status });
  }
  const reason = to === 'active' ? '' : (input.reason ?? '').trim();
  // No awaits: the check above and this write can't interleave with another request.
  return platform.db.transaction(() => {
    const updated = platform.registry.setClubStatus(club.id, to, reason);
    if (!updated) throw httpError(404, 'Club not found', 'not_found');
    recordAdminEvent(platform.db, { adminEmail: input.adminEmail, clubId: club.id, action: input.action, reason });
    return updated;
  });
}

export interface ClubSnapshot {
  file: string;
  size: number;
  /** Remove the temp folder (idempotent). */
  cleanup(): void;
}

/**
 * A consistent, compacted copy of the club's database (`VACUUM INTO` a temp file), whatever
 * its status: an archived club is read through a temporary read-only handle and stays closed.
 * 404 `database_missing` when the club has no database file.
 */
export async function snapshotClubDb(platform: Platform, club: Club): Promise<ClubSnapshot> {
  const source = platform.registry.clubDbFile(club.id);
  if (club.status === 'archived' && !existsSync(source)) {
    throw httpError(404, "This club's database file is missing", 'database_missing');
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cbp-club-backup-'));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    void rm(dir, { recursive: true, force: true });
  };
  const file = path.join(dir, 'club.db');
  try {
    if (club.status === 'archived') {
      withReadOnlyClubDb(source, (sqlite) => sqlite.prepare('VACUUM INTO ?').run(file));
    } else {
      platform.registry.openClubDb(club).$client.prepare('VACUUM INTO ?').run(file);
    }
    return { file, size: (await stat(file)).size, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}
