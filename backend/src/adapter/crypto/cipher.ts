// adapter/crypto/cipher encrypts connection configurations at rest with
// AES-256-GCM. Ciphertext layout: base64(iv[12] || tag[16] || ciphertext).
// Additional authenticated data binds a ciphertext to its row, so a payload
// copied into another user's row fails to decrypt.
//
// Key source (docs/api-contract.md): APP_ENCRYPTION_KEY (base64, 32 bytes),
// otherwise a key generated once and stored in <dataDir>/secret.key with
// mode 0600.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export class CipherError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CipherError';
  }
}

export class AesGcmCipher {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.byteLength !== KEY_BYTES) {
      throw new CipherError(`encryption key must be ${KEY_BYTES} bytes`);
    }
    this.key = Buffer.from(key);
  }

  encrypt(plaintext: string, aad: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]).toString('base64');
  }

  decrypt(payload: string, aad: string): string {
    const raw = Buffer.from(payload, 'base64');
    if (raw.byteLength < IV_BYTES + TAG_BYTES) {
      throw new CipherError('ciphertext is truncated');
    }
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ct = raw.subarray(IV_BYTES + TAG_BYTES);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
        'utf8',
      );
    } catch (err) {
      throw new CipherError(
        'ciphertext failed authentication (wrong key or tampered data)',
        {
          cause: err,
        },
      );
    }
  }
}

function decodeKey(b64: string, source: string): Buffer {
  const key = Buffer.from(b64.trim(), 'base64');
  if (key.byteLength !== KEY_BYTES) {
    throw new CipherError(
      `${source} must be base64 of exactly ${KEY_BYTES} bytes`,
    );
  }
  return key;
}

export interface KeySource {
  key: Buffer;
  origin: 'env' | 'file' | 'generated';
}

/**
 * loadEncryptionKey returns the configured key, or reads/generates
 * <dataDir>/secret.key. Generation uses an exclusive create so two processes
 * starting at once cannot overwrite each other's key.
 */
export function loadEncryptionKey(
  envKey: string | undefined,
  dataDir: string,
): KeySource {
  if (envKey !== undefined) {
    return { key: decodeKey(envKey, 'APP_ENCRYPTION_KEY'), origin: 'env' };
  }
  const path = join(dataDir, 'secret.key');
  try {
    return { key: decodeKey(readFileSync(path, 'utf8'), path), origin: 'file' };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const key = randomBytes(KEY_BYTES);
  try {
    writeFileSync(path, `${key.toString('base64')}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return {
        key: decodeKey(readFileSync(path, 'utf8'), path),
        origin: 'file',
      };
    }
    throw err;
  }
  try {
    // Some filesystems (SMB/CIFS) ignore the create mode; best effort.
    chmodSync(path, 0o600);
  } catch {
    // The mount decides permissions; nothing else to do.
  }
  return { key, origin: 'generated' };
}
