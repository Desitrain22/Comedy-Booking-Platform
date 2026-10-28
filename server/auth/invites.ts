/**
 * Booker invites. An invited booker is a `users` row with no password and an invite
 * token (stored hashed, valid 7 days). `/accept-invite/:token` lets them set a password.
 */
import { and, eq, gt } from 'drizzle-orm';
import { normalizeEmail } from '../../shared/schemas';
import type { Role } from '../../shared/types';
import type { DbOrTx } from '../db/client';
import { users, type User } from '../db/schema';
import { sendEmail, type SendEmailResult } from '../email/mailer';
import { bookerInviteEmail } from '../email/templates';
import { httpError } from '../lib/http';
import { absoluteUrl, getSettings } from '../lib/settings';
import { randomToken, sha256Hex } from './crypto';
import { hashPassword } from './password';

export const INVITE_TTL_MS = 7 * 86_400_000;

export interface InviteResult {
  user: User;
  /** Absolute `/accept-invite/<token>` URL — show it in the UI so it can be copied. */
  inviteUrl: string;
}

function newInviteToken(db: DbOrTx) {
  const token = randomToken();
  return {
    inviteTokenHash: sha256Hex(token),
    inviteExpiresAt: Date.now() + INVITE_TTL_MS,
    inviteUrl: absoluteUrl(db, `/accept-invite/${token}`),
  };
}

/** Create a pending booker. Throws HttpError 409 `email_taken` if the email exists. */
export function createInvite(db: DbOrTx, input: { email: string; name: string; role: Role }): InviteResult {
  const email = normalizeEmail(input.email);
  const existing = db.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
  if (existing) throw httpError(409, 'A booker with that email already exists', 'email_taken');

  const { inviteUrl, ...tokenFields } = newInviteToken(db);
  const user = db
    .insert(users)
    .values({ email, name: input.name.trim(), role: input.role, passwordHash: null, ...tokenFields })
    .returning()
    .get();
  return { user, inviteUrl };
}

/**
 * Issue a fresh invite link for a pending booker (old link stops working).
 * Throws 404 `not_found`, or 409 `already_active` when they already set a password.
 */
export function regenerateInvite(db: DbOrTx, userId: number): InviteResult {
  const current = db.select().from(users).where(eq(users.id, userId)).get();
  if (!current) throw httpError(404, 'Booker not found', 'not_found');
  if (current.passwordHash) throw httpError(409, 'This booker has already joined', 'already_active');

  const { inviteUrl, ...tokenFields } = newInviteToken(db);
  const user = db.update(users).set(tokenFields).where(eq(users.id, userId)).returning().get();
  return { user, inviteUrl };
}

/** Email the invite link. Never throws (see `sendEmail`). */
export function sendBookerInvite(
  db: DbOrTx,
  params: { user: Pick<User, 'email' | 'name'>; inviteUrl: string; inviterName: string },
): Promise<SendEmailResult> {
  const content = bookerInviteEmail({
    clubName: getSettings(db).clubName,
    name: params.user.name,
    inviterName: params.inviterName,
    url: params.inviteUrl,
  });
  return sendEmail(db, { to: params.user.email, kind: 'booker_invite', ...content });
}

/** The pending user for a live invite token, or null. */
export function findInvite(db: DbOrTx, token: string): User | null {
  return (
    db
      .select()
      .from(users)
      .where(and(eq(users.inviteTokenHash, sha256Hex(token)), gt(users.inviteExpiresAt, Date.now())))
      .get() ?? null
  );
}

/** Set the password (and optionally name), clear the invite. Throws 404 `invalid_invite`. */
export async function acceptInvite(
  db: DbOrTx,
  params: { token: string; password: string; name?: string },
): Promise<User> {
  const user = findInvite(db, params.token);
  if (!user) throw httpError(404, 'This invite link is invalid or has expired', 'invalid_invite');
  const passwordHash = await hashPassword(params.password);
  return db
    .update(users)
    .set({
      passwordHash,
      name: params.name?.trim() || user.name,
      inviteTokenHash: null,
      inviteExpiresAt: null,
      lastLoginAt: Date.now(),
    })
    .where(eq(users.id, user.id))
    .returning()
    .get();
}
