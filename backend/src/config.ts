// config loads typed application configuration from environment variables.
//
// Convention: every service env var is prefixed with APP_ (e.g. APP_ADDR).
// The one exception is APPLICATION_DATA_DIR, which the CREATE preview runtime
// sets to the mounted persistent volume. Values are validated via a Zod
// schema; invalid input fails fast at startup with a descriptive error.
//
// Node has a built-in --env-file flag, so this loader does not need a dotenv
// package. tsx's --env-file-if-exists=.env loads it during dev.

import { join, resolve } from 'node:path';

import { z } from 'zod';

const MIB = 1024 * 1024;

export const DEFAULT_ALLOWED_HOST_SUFFIXES = [
  '.mindsphere.io',
  '.siemens.app',
  '.siemens.com',
  '.mindsphere-in.cn',
];

const intFromEnv = (min: number, max: number, def: number) =>
  z.coerce.number().int().min(min).max(max).default(def);

// configSchema describes every supported env var. Defaults are applied at the
// schema level so missing keys become valid values rather than runtime errors.
const configSchema = z.object({
  // TCP address the HTTP server listens on (default ":8080").
  addr: z.string().default(':8080'),
  // Directory for persistent state: SQLite DB, generated encryption key and
  // simulator tenants. The preview runtime mounts its persistent volume at
  // APPLICATION_DATA_DIR; locally it defaults to ./data.
  dataDir: z.string().min(1),
  // SQLite database path; defaults to <dataDir>/app.db. ":memory:" for tests.
  dbPath: z.string().min(1),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  // "dev" enables pino-pretty; all other values emit JSON. Defaults to "prod"
  // so a pruned production install never tries to load pino-pretty.
  env: z.enum(['dev', 'staging', 'prod']).default('prod'),
  // Base64-encoded 32-byte AES-256-GCM key. When unset a key is generated
  // once and stored in <dataDir>/secret.key (mode 0600).
  encryptionKey: z.string().optional(),
  // Host suffixes an apiBaseUrl / tokenUrl must end with (SSRF guard).
  allowedHostSuffixes: z
    .array(z.string().regex(/^\.[a-z0-9.-]+$/, 'must look like ".example.com"'))
    .min(1),
  // Maximum accepted request body size (413 beyond).
  bodyLimitBytes: intFromEnv(1024, 64 * MIB, 10 * MIB),
  // Per-attempt timeout for calls towards Insights Hub.
  upstreamTimeoutMs: intFromEnv(1000, 300_000, 30_000),
  // Maximum concurrent upstream requests per connection.
  upstreamConcurrency: intFromEnv(1, 64, 8),
  // Per-user incoming request rate (token bucket refill per second / burst).
  rateLimitPerSecond: intFromEnv(1, 10_000, 50),
  rateLimitBurst: intFromEnv(1, 100_000, 100),
  // Artificial latency added to every simulator response (0 = off).
  simulatorLatencyMs: intFromEnv(0, 10_000, 0),
  // Directory of the built frontend (apps/web/dist) to serve on / for local
  // installs without a reverse proxy. Unset = API only.
  staticDir: z.string().optional(),
});

// Config is the typed shape returned by loadConfig.
export type Config = z.infer<typeof configSchema>;

function parseSuffixes(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_ALLOWED_HOST_SUFFIXES;
  }
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
    .map((s) => (s.startsWith('.') ? s : `.${s}`));
}

// loadConfig reads the environment and returns a typed Config.
// Throws on invalid values so the process exits rather than running with
// surprising defaults.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(env.APPLICATION_DATA_DIR ?? 'data');
  const parsed = configSchema.safeParse({
    addr: env.APP_ADDR,
    dataDir,
    dbPath: env.APP_DB_PATH ?? join(dataDir, 'app.db'),
    logLevel: env.APP_LOG_LEVEL,
    env: env.APP_ENV,
    encryptionKey:
      env.APP_ENCRYPTION_KEY && env.APP_ENCRYPTION_KEY.trim() !== ''
        ? env.APP_ENCRYPTION_KEY.trim()
        : undefined,
    allowedHostSuffixes: parseSuffixes(env.APP_ALLOWED_HOST_SUFFIXES),
    bodyLimitBytes: env.APP_BODY_LIMIT_BYTES,
    upstreamTimeoutMs: env.APP_UPSTREAM_TIMEOUT_MS,
    upstreamConcurrency: env.APP_UPSTREAM_CONCURRENCY,
    rateLimitPerSecond: env.APP_RATE_LIMIT_PER_SEC,
    rateLimitBurst: env.APP_RATE_LIMIT_BURST,
    simulatorLatencyMs: env.APP_SIMULATOR_LATENCY_MS,
    staticDir:
      env.APP_STATIC_DIR && env.APP_STATIC_DIR.trim() !== ''
        ? resolve(env.APP_STATIC_DIR.trim())
        : undefined,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`config: invalid configuration: ${issues}`);
  }
  return parsed.data;
}
