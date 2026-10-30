/**
 * Setting a club up: name, timezone, app URL, its first location and its first admin. Used by
 * the first-run wizard (`POST /api/setup`, single-club mode) and by hosted sign-up
 * (`POST /api/platform/signup`, which creates a new club database first).
 *
 *   const admin = await setUpClub(db, input);                 // hashes, then applyClubSetup
 *   const admin = applyClubSetup(db, { ...input, admin: { …, passwordHash } });   // sync
 */
import { eq } from 'drizzle-orm';
import { LOCATION_PALETTE } from '../../shared/types';
import { hashPassword } from '../auth/password';
import type { DbOrTx } from '../db/client';
import { locations, users, type User } from '../db/schema';
import { httpError } from '../lib/http';
import { getSettings, updateSettings } from '../lib/settings';

export const ALREADY_SETUP = 'This club is already set up';

export interface ClubSetupInput {
  clubName: string;
  timezone: string;
  /** Base URL for links in emails (no trailing slash). */
  appUrl: string;
  location: { name: string; address?: string; color?: string };
  admin: { name: string; email: string; password: string };
}

/** Like ClubSetupInput, with the admin's password already hashed. */
export interface HashedClubSetupInput extends Omit<ClubSetupInput, 'admin'> {
  admin: { name: string; email: string; passwordHash: string };
}

function alreadySetUp() {
  return httpError(409, ALREADY_SETUP, 'already_setup');
}

/**
 * Save the club settings, create its first location and its admin, in one transaction, and
 * mark setup complete. Throws 409 `already_setup` when the club is already set up (checked
 * inside the transaction: of two racing requests only the first saves anything).
 */
export function applyClubSetup(db: DbOrTx, input: HashedClubSetupInput): User {
  return db.transaction((tx) => {
    if (getSettings(tx).setupComplete) throw alreadySetUp();
    updateSettings(tx, {
      clubName: input.clubName,
      timezone: input.timezone,
      appUrl: input.appUrl,
      setupComplete: true,
    });
    tx.insert(locations)
      .values({
        name: input.location.name,
        address: input.location.address ?? '',
        color: input.location.color ?? LOCATION_PALETTE[0],
        sortOrder: 0,
      })
      .run();
    const { passwordHash } = input.admin;
    // Re-running setup after a half-finished attempt reuses the same admin email.
    const existing = tx.select().from(users).where(eq(users.email, input.admin.email)).get();
    if (existing) {
      return tx
        .update(users)
        .set({ name: input.admin.name, passwordHash, role: 'admin', lastLoginAt: Date.now() })
        .where(eq(users.id, existing.id))
        .returning()
        .get();
    }
    return tx
      .insert(users)
      .values({
        email: input.admin.email,
        name: input.admin.name,
        passwordHash,
        role: 'admin',
        lastLoginAt: Date.now(),
      })
      .returning()
      .get();
  });
}

/**
 * Set the club up (see applyClubSetup). Refuses early, before the slow password hash, when
 * the club is already set up.
 */
export async function setUpClub(db: DbOrTx, input: ClubSetupInput): Promise<User> {
  if (getSettings(db).setupComplete) throw alreadySetUp();
  const passwordHash = await hashPassword(input.admin.password);
  return applyClubSetup(db, {
    ...input,
    admin: { name: input.admin.name, email: input.admin.email, passwordHash },
  });
}
