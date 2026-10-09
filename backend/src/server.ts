// server is the entrypoint for asset-model-studio-backend. It loads the
// configuration, builds the application (src/wiring.ts) and runs the Fastify
// server with graceful shutdown on SIGINT/SIGTERM (in-flight requests finish,
// simulator state is flushed, the database is closed).

import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { buildApplication } from './wiring.js';

export const SERVICE_NAME = 'asset-model-studio-backend';

// version and buildTime are injected at build time via env vars.
const version = process.env.APP_VERSION ?? 'dev';
const buildTime = process.env.APP_BUILD_TIME ?? 'unknown';

// splitAddr parses ":8080" or "0.0.0.0:8080" into [host, port].
function splitAddr(addr: string): [string, string] {
  const idx = addr.lastIndexOf(':');
  if (idx === -1) return ['0.0.0.0', addr];
  const host = addr.slice(0, idx);
  return [host === '' ? '0.0.0.0' : host, addr.slice(idx + 1)];
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const logger = createLogger({
    service: SERVICE_NAME,
    version,
    env: cfg.env,
    level: cfg.logLevel,
  });
  logger.info(
    {
      version,
      build_time: buildTime,
      addr: cfg.addr,
      data_dir: cfg.dataDir,
      db_path: cfg.dbPath,
      allowed_host_suffixes: cfg.allowedHostSuffixes,
    },
    `starting ${SERVICE_NAME}`,
  );

  const [host, portStr] = splitAddr(cfg.addr);
  const port = Number.parseInt(portStr, 10);
  if (!Number.isFinite(port)) {
    logger.error({ addr: cfg.addr }, 'invalid APP_ADDR');
    process.exit(1);
  }

  const application = buildApplication(cfg, logger);
  logger.info({ key_source: application.keySource }, 'encryption key ready');

  await application.app.listen({ host, port });
  logger.info({ addr: cfg.addr }, 'server listening');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down server');
    try {
      await application.close();
      logger.info('server exited cleanly');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'graceful shutdown failed');
      process.exit(1);
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  // The logger may not exist yet (config failure); fall back to stderr.
  console.error(`fatal: failed to start ${SERVICE_NAME}`, err);
  process.exit(1);
});
