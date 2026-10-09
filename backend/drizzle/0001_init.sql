-- 0001_init: connections (encrypted config) and audit log.
-- Idempotent: applied at every startup by src/adapter/sqlite/db.ts.

CREATE TABLE IF NOT EXISTS connections (
  id          TEXT PRIMARY KEY NOT NULL,
  user_id     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  -- AES-256-GCM: base64(iv || tag || ciphertext) of the JSON ConnectionConfig,
  -- authenticated with "connection:<id>:<user_id>" as additional data.
  payload     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS connections_user_idx ON connections (user_id);

CREATE TABLE IF NOT EXISTS audit_log (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  id               TEXT NOT NULL UNIQUE,
  at               TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  connection_id    TEXT,
  connection_name  TEXT,
  kind             TEXT NOT NULL,
  method           TEXT,
  path             TEXT,
  status           INTEGER,
  duration_ms      INTEGER,
  attempts         INTEGER,
  action           TEXT,
  summary          TEXT,
  details          TEXT,
  error            TEXT
);

CREATE INDEX IF NOT EXISTS audit_user_at_idx ON audit_log (user_id, at DESC, seq DESC);
CREATE INDEX IF NOT EXISTS audit_user_conn_at_idx ON audit_log (user_id, connection_id, at DESC, seq DESC);
