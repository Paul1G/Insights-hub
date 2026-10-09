// db.test asserts the SMB-safe SQLite configuration the CREATE preview runtime
// requires (preview spec 06). A file-backed database lives on an Azure Files
// SMB (CIFS) share where WAL is impossible, so journal_mode must be DELETE and
// mmap must be disabled. If this drifts, preview persistence breaks.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDatabase, openDatabase, type DatabaseHandle } from './db.js';

let handle: DatabaseHandle | undefined;
let dir: string | undefined;

afterEach(() => {
  if (handle) closeDatabase(handle);
  if (dir) rmSync(dir, { recursive: true, force: true });
  handle = undefined;
  dir = undefined;
});

describe('openDatabase SMB-safe PRAGMAs', () => {
  it('uses a rollback journal (never WAL) and disables mmap on a file DB', () => {
    dir = mkdtempSync(join(tmpdir(), 'ams-db-'));
    handle = openDatabase(join(dir, 'app.db'));

    const journalMode = handle.raw.prepare('PRAGMA journal_mode').get() as {
      journal_mode: string;
    };
    expect(journalMode.journal_mode).toBe('delete');

    const mmap = handle.raw.prepare('PRAGMA mmap_size').get() as {
      mmap_size: number | bigint;
    };
    expect(Number(mmap.mmap_size)).toBe(0);
  });
});
