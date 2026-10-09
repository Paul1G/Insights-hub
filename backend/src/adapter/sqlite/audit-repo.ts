// adapter/sqlite/audit-repo implements AuditRepository on SQLite. Entries are
// append-only and queried newest first per user.

import type {
  AuditEntry,
  AuditKind,
  AuditQuery,
  AuditRepository,
} from '../../domain/audit/audit.js';

import type { DatabaseHandle } from './db.js';

interface Row {
  id: string;
  at: string;
  user_id: string;
  connection_id: string | null;
  connection_name: string | null;
  kind: string;
  method: string | null;
  path: string | null;
  status: number | null;
  duration_ms: number | null;
  attempts: number | null;
  action: string | null;
  summary: string | null;
  details: string | null;
  error: string | null;
}

export class SqliteAuditRepository implements AuditRepository {
  private readonly db: DatabaseHandle;

  constructor(db: DatabaseHandle) {
    this.db = db;
  }

  append(e: AuditEntry): Promise<void> {
    this.db.raw
      .prepare(
        `INSERT INTO audit_log (id, at, user_id, connection_id, connection_name, kind, method, path,
           status, duration_ms, attempts, action, summary, details, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.id,
        e.at,
        e.userId,
        e.connectionId ?? null,
        e.connectionName ?? null,
        e.kind,
        e.method ?? null,
        e.path ?? null,
        e.status ?? null,
        e.durationMs !== undefined ? Math.round(e.durationMs) : null,
        e.attempts ?? null,
        e.action ?? null,
        e.summary ?? null,
        e.details !== undefined ? JSON.stringify(e.details) : null,
        e.error ?? null,
      );
    return Promise.resolve();
  }

  query(q: AuditQuery): Promise<AuditEntry[]> {
    const where: string[] = ['user_id = ?'];
    const args: (string | number)[] = [q.userId];
    if (q.connectionId !== undefined) {
      where.push('connection_id = ?');
      args.push(q.connectionId);
    }
    if (q.before !== undefined) {
      where.push('at < ?');
      args.push(q.before);
    }
    args.push(q.limit);
    const rows = this.db.raw
      .prepare(
        `SELECT id, at, user_id, connection_id, connection_name, kind, method, path, status,
                duration_ms, attempts, action, summary, details, error
           FROM audit_log WHERE ${where.join(' AND ')}
          ORDER BY at DESC, seq DESC LIMIT ?`,
      )
      .all(...args) as unknown as Row[];
    return Promise.resolve(rows.map(toEntry));
  }
}

function toEntry(r: Row): AuditEntry {
  const e: AuditEntry = {
    id: r.id,
    at: r.at,
    userId: r.user_id,
    kind: r.kind as AuditKind,
  };
  if (r.connection_id !== null) e.connectionId = r.connection_id;
  if (r.connection_name !== null) e.connectionName = r.connection_name;
  if (r.method !== null) e.method = r.method;
  if (r.path !== null) e.path = r.path;
  if (r.status !== null) e.status = Number(r.status);
  if (r.duration_ms !== null) e.durationMs = Number(r.duration_ms);
  if (r.attempts !== null) e.attempts = Number(r.attempts);
  if (r.action !== null) e.action = r.action;
  if (r.summary !== null) e.summary = r.summary;
  if (r.details !== null)
    e.details = JSON.parse(r.details) as Record<string, unknown>;
  if (r.error !== null) e.error = r.error;
  return e;
}
