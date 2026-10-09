// domain/audit models the audit log. Entries record who did what against
// which connection — never request/response bodies or secrets.
// AuditEntry / AuditAppend match apps/web/src/api/client.ts.

export type AuditKind = 'upstream' | 'connection' | 'action';

export interface AuditEntry {
  id: string;
  at: string;
  userId: string;
  connectionId?: string;
  connectionName?: string;
  kind: AuditKind;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  attempts?: number;
  action?: string;
  summary?: string;
  details?: Record<string, unknown>;
  error?: string;
}

export interface AuditAppend {
  connectionId?: string;
  action: string;
  summary: string;
  details?: Record<string, unknown>;
}

export interface AuditQuery {
  userId: string;
  connectionId?: string;
  /** 1..500 */
  limit: number;
  /** ISO timestamp; only entries strictly older are returned. */
  before?: string;
}

export const AUDIT_LIMIT_DEFAULT = 100;
export const AUDIT_LIMIT_MAX = 500;

export interface AuditRepository {
  append(entry: AuditEntry): Promise<void>;
  /** Newest first. */
  query(q: AuditQuery): Promise<AuditEntry[]>;
}

const SECRET_KEY =
  /secret|password|passwd|token|authorization|api[-_]?key|credential/i;

/**
 * redactDetails removes credential-looking keys from app-supplied details so
 * a careless caller cannot persist secrets in the audit log.
 */
export function redactDetails(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (Array.isArray(value))
    return value.map((v) => redactDetails(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[REDACTED]' : redactDetails(v, depth + 1);
    }
    return out;
  }
  return value;
}
