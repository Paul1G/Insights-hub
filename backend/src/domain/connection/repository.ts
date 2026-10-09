// domain/connection/repository is the persistence port for connections.
// Every operation is scoped by the owner (user scope); a connection that
// belongs to another user is indistinguishable from a missing one.

import type { ConnectionRecord } from './connection.js';

export interface ConnectionRepository {
  list(userId: string): Promise<ConnectionRecord[]>;
  get(userId: string, id: string): Promise<ConnectionRecord | undefined>;
  insert(rec: ConnectionRecord): Promise<void>;
  /** Returns false when no row matched (missing or other owner). */
  update(rec: ConnectionRecord): Promise<boolean>;
  /** Returns false when no row matched (missing or other owner). */
  delete(userId: string, id: string): Promise<boolean>;
}
