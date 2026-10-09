// adapter/sqlite/schema is the Drizzle view of the tables created by
// drizzle/0001_init.sql (used for drizzle-kit and as typed documentation).
// The repositories query through node:sqlite prepared statements directly.

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const connections = sqliteTable('connections', {
  id: text('id').primaryKey().notNull(),
  userId: text('user_id').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  payload: text('payload').notNull(),
});

export const auditLog = sqliteTable('audit_log', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  at: text('at').notNull(),
  userId: text('user_id').notNull(),
  connectionId: text('connection_id'),
  connectionName: text('connection_name'),
  kind: text('kind').notNull(),
  method: text('method'),
  path: text('path'),
  status: integer('status'),
  durationMs: integer('duration_ms'),
  attempts: integer('attempts'),
  action: text('action'),
  summary: text('summary'),
  details: text('details'),
  error: text('error'),
});

export type ConnectionRow = typeof connections.$inferSelect;
export type AuditRow = typeof auditLog.$inferSelect;
