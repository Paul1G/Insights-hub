// adapter/sqlite/db opens a SQLite connection and applies the schema.
//
// Backing driver: Node 24's built-in `node:sqlite` module (flag-free) — no
// native compile, no extra npm dependency. The repository implementations use the raw
// DatabaseSync handle directly for queries; Drizzle's schema-as-code
// (schema.ts) describes the same tables for type inference, migration
// generation (drizzle-kit), and documentation.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// DatabaseHandle bundles the raw node:sqlite handle.
// Adapters accept a DatabaseHandle (not a DatabaseSync directly) so future
// additions (statement caches, metrics hooks) can be threaded through without
// changing repository constructors.
export interface DatabaseHandle {
  raw: DatabaseSync;
}

// openDatabase opens a SQLite database at the given path and applies sane
// PRAGMAs for production use.
//
// Path semantics:
//   "<dataDir>/app.db" → file-backed database (directory must exist)
//   ":memory:"         → ephemeral in-process database (one per call)
export function openDatabase(path: string): DatabaseHandle {
  const raw = new DatabaseSync(path);

  if (path !== ':memory:') {
    // SMB-safe configuration: the CREATE preview runtime stores this DB on an
    // Azure Files SMB (CIFS) share, where SQLite's default WAL mode CANNOT work
    // (WAL needs shared-memory mmap that CIFS does not provide). The platform
    // guarantees exactly one writer pod, so taking the write lock once
    // (EXCLUSIVE) is safe and avoids fragile CIFS byte-range locks. busy_timeout
    // retries brief contention; mmap is disabled (no mmap over SMB).
    raw.exec('PRAGMA journal_mode = DELETE'); // never WAL
    raw.exec('PRAGMA locking_mode = EXCLUSIVE');
    raw.exec('PRAGMA busy_timeout = 5000');
    raw.exec('PRAGMA mmap_size = 0');
  }
  raw.exec('PRAGMA foreign_keys = ON');

  return { raw };
}

// migrate applies the bundled DDL to the database. Idempotent: every statement
// uses IF NOT EXISTS guards so repeated calls (e.g. across tests) are safe.
//
// In a production deploy you would instead run drizzle-kit's migrations from
// the `drizzle/` directory via `pnpm db:migrate`; this in-process call keeps
// the service runnable without an extra CLI step on first launch.
export function migrate(handle: DatabaseHandle): void {
  // Resolve drizzle/0001_init.sql relative to this file so the path works in
  // both tsx (dev) and the compiled dist/ output.
  const here = dirname(fileURLToPath(import.meta.url));
  const sqlPath = resolve(here, '..', '..', '..', 'drizzle', '0001_init.sql');
  const ddl = readFileSync(sqlPath, 'utf8');
  handle.raw.exec(ddl);
}

// closeDatabase shuts the underlying connection. Safe to call once at process
// exit; subsequent operations on the handle will throw.
export function closeDatabase(handle: DatabaseHandle): void {
  handle.raw.close();
}

// ping verifies the database is responsive. Used by /readyz.
// Returns true on success, false on any error.
export function ping(handle: DatabaseHandle): boolean {
  try {
    handle.raw.prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}
