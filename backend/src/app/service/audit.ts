// app/service/audit records and queries the per-user audit log. Recording an
// upstream/connection event never fails the caller's request: a storage
// failure is logged and swallowed. App-level appends (POST /api/audit) do
// surface failures, because there the entry itself is the result.

import {
  AUDIT_LIMIT_DEFAULT,
  AUDIT_LIMIT_MAX,
  redactDetails,
  type AuditAppend,
  type AuditEntry,
  type AuditRepository,
} from '../../domain/audit/audit.js';
import type { ConnectionRepository } from '../../domain/connection/repository.js';
import { ValidationError } from '../../domain/errors.js';
import type { Identity } from '../../domain/identity.js';
import type { Logger } from '../../log.js';
import type { Clock } from '../../platform/clock.js';

export type AuditEvent = Omit<AuditEntry, 'id' | 'at'>;

const MAX_DETAILS_BYTES = 16 * 1024;

export interface AuditListInput {
  connectionId?: string;
  limit?: number;
  before?: string;
}

export class AuditService {
  private readonly repo: AuditRepository;
  private readonly connections: ConnectionRepository;
  private readonly clock: Clock;
  private readonly newId: () => string;
  private readonly logger: Logger;

  constructor(o: {
    repo: AuditRepository;
    connections: ConnectionRepository;
    clock: Clock;
    newId: () => string;
    logger: Logger;
  }) {
    this.repo = o.repo;
    this.connections = o.connections;
    this.clock = o.clock;
    this.newId = o.newId;
    this.logger = o.logger;
  }

  /** Best-effort write of a system event (upstream call, connection change). */
  async record(event: AuditEvent): Promise<void> {
    const entry: AuditEntry = {
      id: this.newId(),
      at: new Date(this.clock.now()).toISOString(),
      ...event,
    };
    try {
      await this.repo.append(entry);
    } catch (err) {
      this.logger.error(
        { err, kind: event.kind, method: event.method, path: event.path },
        'audit: failed to record event',
      );
    }
  }

  async append(identity: Identity, input: AuditAppend): Promise<AuditEntry> {
    let details: Record<string, unknown> | undefined;
    if (input.details !== undefined) {
      details = redactDetails(input.details) as Record<string, unknown>;
      if (
        Buffer.byteLength(JSON.stringify(details), 'utf8') > MAX_DETAILS_BYTES
      ) {
        throw new ValidationError(
          `details must not exceed ${MAX_DETAILS_BYTES} bytes when serialised`,
        );
      }
    }
    let connectionName: string | undefined;
    if (input.connectionId) {
      // Entries may reference connections that were deleted meanwhile; the
      // name is attached only when the caller still owns the connection.
      const rec = await this.connections.get(
        identity.scope,
        input.connectionId,
      );
      connectionName = rec?.config.name;
    }
    const entry: AuditEntry = {
      id: this.newId(),
      at: new Date(this.clock.now()).toISOString(),
      userId: identity.scope,
      kind: 'action',
      action: input.action,
      summary: input.summary,
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      ...(connectionName ? { connectionName } : {}),
      ...(details ? { details } : {}),
    };
    await this.repo.append(entry);
    return entry;
  }

  async list(identity: Identity, q: AuditListInput): Promise<AuditEntry[]> {
    const limit = q.limit ?? AUDIT_LIMIT_DEFAULT;
    if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_LIMIT_MAX) {
      throw new ValidationError(
        `limit must be an integer between 1 and ${AUDIT_LIMIT_MAX}`,
      );
    }
    let before: string | undefined;
    if (q.before !== undefined) {
      const t = Date.parse(q.before);
      if (Number.isNaN(t))
        throw new ValidationError('before must be an ISO-8601 timestamp');
      before = new Date(t).toISOString();
    }
    return this.repo.query({
      userId: identity.scope,
      limit,
      ...(q.connectionId ? { connectionId: q.connectionId } : {}),
      ...(before ? { before } : {}),
    });
  }
}
