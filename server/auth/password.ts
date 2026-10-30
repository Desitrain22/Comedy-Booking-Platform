import bcrypt from 'bcryptjs';
import { randomToken } from './crypto';

/** bcrypt cost: `BCRYPT_ROUNDS` (4–15), default 10. */
export function bcryptRounds(): number {
  const n = Number(process.env.BCRYPT_ROUNDS);
  return Number.isInteger(n) && n >= 4 && n <= 15 ? n : 10;
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, bcryptRounds());
}

export function verifyPassword(password: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(password, hash);
}

let dummyHash: { rounds: number; hash: Promise<string> } | undefined;

/**
 * A bcrypt hash of a random throwaway password, made with the configured cost. Sign-in
 * checks unknown emails (and invitees without a password) against it, so a wrong email
 * takes as long as a wrong password — even when BCRYPT_ROUNDS isn't the default.
 * `createApp` computes it at startup; later calls reuse it.
 */
export function timingDummyHash(): Promise<string> {
  const rounds = bcryptRounds();
  if (!dummyHash || dummyHash.rounds !== rounds) {
    dummyHash = { rounds, hash: bcrypt.hash(randomToken(), rounds) };
  }
  return dummyHash.hash;
}
