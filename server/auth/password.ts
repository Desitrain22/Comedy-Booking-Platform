import bcrypt from 'bcryptjs';

function rounds(): number {
  const n = Number(process.env.BCRYPT_ROUNDS);
  return Number.isInteger(n) && n >= 4 && n <= 15 ? n : 10;
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, rounds());
}

export function verifyPassword(password: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(password, hash);
}
