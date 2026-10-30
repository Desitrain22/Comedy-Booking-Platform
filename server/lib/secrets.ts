/**
 * Secrets at rest (hosted MVP spec §5): mailbox passwords (the company mailbox in
 * `settings.smtpPass`, each booker's in `users.smtpPass`).
 *
 * With APP_SECRET set (required in hosted mode), values are stored as
 * `enc:v1:<iv b64>:<tag b64>:<data b64>` — AES-256-GCM with a 12-byte random IV and a key
 * derived from the secret (sha256 of a fixed label + the secret). Without it (a
 * self-hosted single club that never set one) they stay plaintext, as before. Reading
 * accepts both, so a club that turns APP_SECRET on keeps working: older plaintext values
 * pass through and are encrypted the next time they're saved.
 *
 * Decrypting with the wrong key (APP_SECRET changed) throws `SecretDecryptError`: the
 * password has to be entered again.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../env';

const PREFIX = 'enc:v1:';
const KEY_LABEL = 'comedy-booking-platform:secrets:v1\0';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SecretDecryptError extends Error {
  constructor(message = "The saved password can't be read (was APP_SECRET changed?). Enter it again.") {
    super(message);
    this.name = 'SecretDecryptError';
  }
}

function keyFor(secret: string): Buffer {
  return createHash('sha256').update(KEY_LABEL).update(secret, 'utf8').digest();
}

/** True for a value written by `encryptSecret` (as opposed to legacy plaintext). */
export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(PREFIX);
}

/**
 * The value to store: encrypted when there's an app secret (default `env.appSecret`),
 * plaintext otherwise. '' stays '' (no password).
 */
export function encryptSecret(plain: string, secret: string | null = env.appSecret): string {
  if (plain === '' || !secret) return plain;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyFor(secret), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
}

/**
 * The plaintext of a stored value. Legacy plaintext passes through unchanged. Throws
 * `SecretDecryptError` when an encrypted value can't be read (no or wrong secret, or the
 * value was tampered with).
 */
export function decryptSecret(stored: string, secret: string | null = env.appSecret): string {
  if (!isEncryptedSecret(stored)) return stored;
  if (!secret) throw new SecretDecryptError("The saved password is encrypted but APP_SECRET isn't set. Set it, or enter the password again.");
  const parts = stored.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new SecretDecryptError();
  const [iv, tag, data] = parts.map((p) => Buffer.from(p, 'base64')) as [Buffer, Buffer, Buffer];
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new SecretDecryptError();
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyFor(secret), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretDecryptError();
  }
}
