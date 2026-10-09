// adapter/sqlite/connection-repo implements ConnectionRepository on SQLite.
// Only id, owner and timestamps are stored in clear text; the complete
// ConnectionConfig (name, URLs, credentials, last test) is AES-256-GCM
// encrypted, bound to "connection:<id>:<user_id>".

import type {
  ConnectionConfig,
  ConnectionRecord,
} from '../../domain/connection/connection.js';
import type { ConnectionRepository } from '../../domain/connection/repository.js';
import type { AesGcmCipher } from '../crypto/cipher.js';

import type { DatabaseHandle } from './db.js';

interface Row {
  id: string;
  user_id: string;
  created_at: string;
  updated_at: string;
  payload: string;
}

const aad = (id: string, userId: string): string =>
  `connection:${id}:${userId}`;

export class SqliteConnectionRepository implements ConnectionRepository {
  private readonly db: DatabaseHandle;
  private readonly cipher: AesGcmCipher;

  constructor(db: DatabaseHandle, cipher: AesGcmCipher) {
    this.db = db;
    this.cipher = cipher;
  }

  list(userId: string): Promise<ConnectionRecord[]> {
    const rows = this.db.raw
      .prepare(
        'SELECT id, user_id, created_at, updated_at, payload FROM connections WHERE user_id = ? ORDER BY created_at, id',
      )
      .all(userId) as unknown as Row[];
    return Promise.resolve(rows.map((r) => this.toRecord(r)));
  }

  get(userId: string, id: string): Promise<ConnectionRecord | undefined> {
    const row = this.db.raw
      .prepare(
        'SELECT id, user_id, created_at, updated_at, payload FROM connections WHERE user_id = ? AND id = ?',
      )
      .get(userId, id) as unknown as Row | undefined;
    return Promise.resolve(row ? this.toRecord(row) : undefined);
  }

  insert(rec: ConnectionRecord): Promise<void> {
    this.db.raw
      .prepare(
        'INSERT INTO connections (id, user_id, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?)',
      )
      .run(rec.id, rec.userId, rec.createdAt, rec.updatedAt, this.seal(rec));
    return Promise.resolve();
  }

  update(rec: ConnectionRecord): Promise<boolean> {
    const res = this.db.raw
      .prepare(
        'UPDATE connections SET updated_at = ?, payload = ? WHERE id = ? AND user_id = ?',
      )
      .run(rec.updatedAt, this.seal(rec), rec.id, rec.userId);
    return Promise.resolve(Number(res.changes) > 0);
  }

  delete(userId: string, id: string): Promise<boolean> {
    const res = this.db.raw
      .prepare('DELETE FROM connections WHERE id = ? AND user_id = ?')
      .run(id, userId);
    return Promise.resolve(Number(res.changes) > 0);
  }

  private seal(rec: ConnectionRecord): string {
    return this.cipher.encrypt(
      JSON.stringify(rec.config),
      aad(rec.id, rec.userId),
    );
  }

  private toRecord(row: Row): ConnectionRecord {
    const config = JSON.parse(
      this.cipher.decrypt(row.payload, aad(row.id, row.user_id)),
    ) as ConnectionConfig;
    return {
      id: row.id,
      userId: row.user_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      config,
    };
  }
}
