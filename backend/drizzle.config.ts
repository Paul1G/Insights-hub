// drizzle.config configures drizzle-kit, the migration / schema-introspection
// CLI. The runtime adapter (src/adapter/sqlite/db.ts) does not depend on this
// file — it embeds the SQL migration directly so the service runs without the
// drizzle-kit CLI being installed.

import type { Config } from 'drizzle-kit';

const config: Config = {
  schema: './src/adapter/sqlite/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.APP_DB_PATH ?? 'data/app.db',
  },
  // Strict mode catches schema-vs-database drift on every `drizzle-kit generate`.
  strict: true,
  verbose: true,
};

export default config;
