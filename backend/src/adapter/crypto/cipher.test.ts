import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { tempDir } from '../../test-support/helpers.js';

import { AesGcmCipher, CipherError, loadEncryptionKey } from './cipher.js';

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

describe('AesGcmCipher', () => {
  it('round-trips and never contains the plaintext', () => {
    const c = new AesGcmCipher(randomBytes(32));
    const secret = JSON.stringify({ clientSecret: 'super-secret-value' });
    const sealed = c.encrypt(secret, 'connection:1:alice');
    expect(sealed).not.toContain('super-secret');
    expect(Buffer.from(sealed, 'base64').toString('utf8')).not.toContain(
      'super-secret',
    );
    expect(c.decrypt(sealed, 'connection:1:alice')).toBe(secret);
    expect(c.encrypt(secret, 'x')).not.toBe(c.encrypt(secret, 'x'));
  });

  it('rejects a wrong AAD, a wrong key and tampered data', () => {
    const key = randomBytes(32);
    const c = new AesGcmCipher(key);
    const sealed = c.encrypt('data', 'connection:1:alice');
    expect(() => c.decrypt(sealed, 'connection:1:bob')).toThrow(CipherError);
    expect(() =>
      new AesGcmCipher(randomBytes(32)).decrypt(sealed, 'connection:1:alice'),
    ).toThrow(CipherError);
    const raw = Buffer.from(sealed, 'base64');
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0xff;
    expect(() =>
      c.decrypt(raw.toString('base64'), 'connection:1:alice'),
    ).toThrow(CipherError);
    expect(() => new AesGcmCipher(randomBytes(16))).toThrow(CipherError);
  });
});

describe('loadEncryptionKey', () => {
  it('uses APP_ENCRYPTION_KEY when set and validates its length', () => {
    const dir = tempDir();
    cleanup = dir.cleanup;
    const key = randomBytes(32);
    const src = loadEncryptionKey(key.toString('base64'), dir.path);
    expect(src.origin).toBe('env');
    expect(src.key.equals(key)).toBe(true);
    expect(() =>
      loadEncryptionKey(randomBytes(8).toString('base64'), dir.path),
    ).toThrow(/32 bytes/);
  });

  it('generates secret.key once with mode 0600 and reuses it', () => {
    const dir = tempDir();
    cleanup = dir.cleanup;
    const first = loadEncryptionKey(undefined, dir.path);
    expect(first.origin).toBe('generated');
    const path = join(dir.path, 'secret.key');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(
      Buffer.from(readFileSync(path, 'utf8').trim(), 'base64').equals(
        first.key,
      ),
    ).toBe(true);
    const second = loadEncryptionKey(undefined, dir.path);
    expect(second.origin).toBe('file');
    expect(second.key.equals(first.key)).toBe(true);
  });
});
