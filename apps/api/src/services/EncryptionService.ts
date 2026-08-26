import crypto from 'crypto';

import {SMTP_CREDENTIALS_ENCRYPTION_KEY, SMTP_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS} from '../app/constants.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // recommended nonce length for GCM

interface Ciphertext {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
}

/**
 * Encrypts/decrypts tenant-supplied secrets at rest — currently just per-project
 * SMTP passwords (see SmtpConfig). AES-256-GCM is authenticated encryption: it
 * protects against ciphertext tampering, not just confidentiality, which matters
 * here because the plaintext is used to authenticate to a third-party server.
 *
 * The key is sourced from SMTP_CREDENTIALS_ENCRYPTION_KEY (via the company secret
 * manager in every deployed environment) — never hardcoded, and never defaulted:
 * encrypt() throws if it isn't set rather than silently storing plaintext.
 *
 * Key rotation: decrypt() tries the current key first, and — if that fails
 * authentication — falls back to SMTP_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS when
 * configured. This makes rotation safe without needing to track which specific
 * key version encrypted which row: set the previous key, rotate the current one,
 * deploy, then re-save (or run a one-off re-encryption pass over) each SmtpConfig
 * to move it onto the new key, and only then remove the previous-key env var.
 */
export class EncryptionService {
  /**
   * Encrypt a plaintext secret under the current encryption key.
   * Throws if SMTP_CREDENTIALS_ENCRYPTION_KEY is not configured.
   */
  public static encrypt(plaintext: string): Ciphertext {
    const key = EncryptionService.requireCurrentKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      ciphertext: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
    };
  }

  /**
   * Decrypt a secret previously produced by encrypt(). Tries the current key,
   * then the previous key (if configured) — see the class doc for why.
   */
  public static decrypt({ciphertext, iv, authTag}: Ciphertext): string {
    const candidateKeys = [SMTP_CREDENTIALS_ENCRYPTION_KEY, SMTP_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS].filter(
      key => key !== '',
    );

    if (candidateKeys.length === 0) {
      throw new Error(
        'SMTP_CREDENTIALS_ENCRYPTION_KEY is not configured — cannot decrypt stored SMTP credentials.',
      );
    }

    let lastError: unknown;
    for (const rawKey of candidateKeys) {
      try {
        const key = EncryptionService.deriveKey(rawKey);
        const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
        decipher.setAuthTag(Buffer.from(authTag, 'base64'));
        const decrypted = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
        return decrypted.toString('utf8');
      } catch (error) {
        lastError = error;
        // Wrong key (or corrupted data) — try the next candidate, if any.
      }
    }

    throw new Error(
      `Failed to decrypt SMTP credential: ${lastError instanceof Error ? lastError.message : 'unknown error'}`,
    );
  }

  /**
   * Convenience wrapper matching SmtpConfig's column shape directly, so call
   * sites don't hand-map ciphertext/iv/authTag <-> encryptedPassword/passwordIv/passwordAuthTag.
   */
  public static encryptPassword(plaintext: string): {
    encryptedPassword: string;
    passwordIv: string;
    passwordAuthTag: string;
  } {
    const {ciphertext, iv, authTag} = EncryptionService.encrypt(plaintext);
    return {encryptedPassword: ciphertext, passwordIv: iv, passwordAuthTag: authTag};
  }

  public static decryptPassword(config: {
    encryptedPassword: string;
    passwordIv: string;
    passwordAuthTag: string;
  }): string {
    return EncryptionService.decrypt({
      ciphertext: config.encryptedPassword,
      iv: config.passwordIv,
      authTag: config.passwordAuthTag,
    });
  }

  private static requireCurrentKey(): Buffer {
    if (SMTP_CREDENTIALS_ENCRYPTION_KEY === '') {
      throw new Error(
        'SMTP_CREDENTIALS_ENCRYPTION_KEY is not configured. Set it (via the secret manager) before enabling a custom SMTP sending provider.',
      );
    }
    return EncryptionService.deriveKey(SMTP_CREDENTIALS_ENCRYPTION_KEY);
  }

  private static deriveKey(base64Key: string): Buffer {
    const key = Buffer.from(base64Key, 'base64');
    if (key.length !== 32) {
      throw new Error('SMTP credentials encryption key must decode to exactly 32 bytes (AES-256).');
    }
    return key;
  }
}
