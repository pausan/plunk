import crypto from 'crypto';

import {describe, expect, it} from 'vitest';

import {EncryptionService} from '../EncryptionService';

describe('EncryptionService', () => {
  it('round-trips a plaintext secret', () => {
    const encrypted = EncryptionService.encrypt('hunter2');
    expect(encrypted.ciphertext).not.toBe('hunter2');
    expect(EncryptionService.decrypt(encrypted)).toBe('hunter2');
  });

  it('produces a different ciphertext/IV on every call (random nonce)', () => {
    const a = EncryptionService.encrypt('same-plaintext');
    const b = EncryptionService.encrypt('same-plaintext');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('throws on a tampered auth tag rather than silently returning garbage', () => {
    const encrypted = EncryptionService.encrypt('hunter2');
    const tamperedAuthTag = Buffer.from(encrypted.authTag, 'base64');
    tamperedAuthTag[0] = tamperedAuthTag[0] ^ 0xff;

    expect(() =>
      EncryptionService.decrypt({...encrypted, authTag: tamperedAuthTag.toString('base64')}),
    ).toThrow();
  });

  it('round-trips through the encryptPassword/decryptPassword SmtpConfig-shaped helpers', () => {
    const stored = EncryptionService.encryptPassword('super-secret-smtp-password');
    expect(stored.encryptedPassword).toBeTypeOf('string');
    expect(stored.passwordIv).toBeTypeOf('string');
    expect(stored.passwordAuthTag).toBeTypeOf('string');
    expect(EncryptionService.decryptPassword(stored)).toBe('super-secret-smtp-password');
  });

  it('falls back to SMTP_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS for ciphertext encrypted under a rotated-out key', () => {
    // Simulate a row that was encrypted before a key rotation: build ciphertext
    // by hand using the PREVIOUS key directly (never through EncryptionService,
    // which always encrypts under the current key) — the same way a real
    // pre-rotation row would have been written under the then-current key.
    const previousKey = Buffer.from(process.env.SMTP_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS!, 'base64');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', previousKey, iv);
    const ciphertext = Buffer.concat([cipher.update('old-password', 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const decrypted = EncryptionService.decrypt({
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
    });

    expect(decrypted).toBe('old-password');
  });

  it('throws a clear error when neither key can decrypt the ciphertext', () => {
    const wrongKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', wrongKey, iv);
    const ciphertext = Buffer.concat([cipher.update('nope', 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    expect(() =>
      EncryptionService.decrypt({
        ciphertext: ciphertext.toString('base64'),
        iv: iv.toString('base64'),
        authTag: authTag.toString('base64'),
      }),
    ).toThrow(/Failed to decrypt/);
  });
});
