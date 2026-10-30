import { describe, expect, it } from 'vitest';
import { SecretDecryptError, decryptSecret, encryptSecret, isEncryptedSecret } from './secrets';

const KEY = 'app-secret-one';

describe('encryptSecret / decryptSecret', () => {
  it('round-trips through AES-256-GCM in the enc:v1 format', () => {
    const stored = encryptSecret('abcd efgh ijkl mnop', KEY);
    expect(stored).toMatch(/^enc:v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(stored).not.toContain('abcd');
    expect(isEncryptedSecret(stored)).toBe(true);
    const [iv, tag] = stored.slice('enc:v1:'.length).split(':').map((p) => Buffer.from(p, 'base64'));
    expect(iv).toHaveLength(12);
    expect(tag).toHaveLength(16);
    expect(decryptSecret(stored, KEY)).toBe('abcd efgh ijkl mnop');
  });

  it('uses a fresh IV every time', () => {
    const a = encryptSecret('same', KEY);
    const b = encryptSecret('same', KEY);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, KEY)).toBe('same');
    expect(decryptSecret(b, KEY)).toBe('same');
  });

  it('handles unicode and long values', () => {
    const value = `pässwörd 🔑 ${'x'.repeat(480)}`;
    expect(decryptSecret(encryptSecret(value, KEY), KEY)).toBe(value);
  });

  it('passes legacy plaintext through on read', () => {
    expect(decryptSecret('hunter2-secret', KEY)).toBe('hunter2-secret');
    expect(decryptSecret('hunter2-secret', null)).toBe('hunter2-secret');
    expect(decryptSecret('', KEY)).toBe('');
    expect(isEncryptedSecret('hunter2-secret')).toBe(false);
  });

  it('stores plaintext when there is no app secret, and never encrypts an empty password', () => {
    expect(encryptSecret('hunter2-secret', null)).toBe('hunter2-secret');
    expect(encryptSecret('', KEY)).toBe('');
  });

  it('refuses to decrypt with the wrong key', () => {
    const stored = encryptSecret('hunter2-secret', KEY);
    expect(() => decryptSecret(stored, 'app-secret-two')).toThrow(SecretDecryptError);
    expect(() => decryptSecret(stored, 'app-secret-two')).toThrow(/APP_SECRET/);
  });

  it('refuses an encrypted value when APP_SECRET is not set', () => {
    const stored = encryptSecret('hunter2-secret', KEY);
    expect(() => decryptSecret(stored, null)).toThrow(SecretDecryptError);
  });

  it('detects tampering and malformed values', () => {
    const stored = encryptSecret('hunter2-secret', KEY);
    const [iv, tag, data] = stored.slice('enc:v1:'.length).split(':') as [string, string, string];
    const flipped = Buffer.from(data, 'base64');
    flipped[0] = flipped[0]! ^ 1;
    expect(() => decryptSecret(`enc:v1:${iv}:${tag}:${flipped.toString('base64')}`, KEY)).toThrow(SecretDecryptError);
    expect(() => decryptSecret(`enc:v1:${iv}:${data}`, KEY)).toThrow(SecretDecryptError);
    expect(() => decryptSecret(`enc:v1:${iv}:AAAA:${data}`, KEY)).toThrow(SecretDecryptError);
  });
});
