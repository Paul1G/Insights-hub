// log is the service's structured-logging factory.
//
// It wraps pino and produces a Logger that emits JSON in production and
// human-readable text via pino-pretty in dev. The logger bakes service,
// version, and env into every record at construction time.
//
// Secrets must never reach the log: request bodies are never logged, and the
// redact list below censors credential-bearing fields defensively in case a
// structured object carrying them is ever passed to the logger.

import { pino, type Logger, type LoggerOptions } from 'pino';

export interface LogOptions {
  service: string;
  version: string;
  env: 'dev' | 'staging' | 'prod';
  level: 'debug' | 'info' | 'warn' | 'error' | 'silent';
}

// REDACT_PATHS lists every field name that may carry a credential.
export const REDACT_PATHS = [
  'authorization',
  'Authorization',
  'headers.authorization',
  'headers["x-space-auth-key"]',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-space-auth-key"]',
  'clientSecret',
  'token',
  'accessToken',
  'access_token',
  'secret',
  'password',
  '*.authorization',
  '*.Authorization',
  '*.clientSecret',
  '*.token',
  '*.accessToken',
  '*.access_token',
  '*.secret',
  '*.password',
  '*.headers.authorization',
  '*.headers["x-space-auth-key"]',
  'auth.clientSecret',
  'auth.token',
  'config.auth.clientSecret',
  'config.auth.token',
];

export function createLogger(o: LogOptions): Logger {
  const base: LoggerOptions = {
    level: o.level,
    base: {
      service: o.service,
      version: o.version,
      env: o.env,
    },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
  };

  if (o.env === 'dev') {
    try {
      return pino({
        ...base,
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      });
    } catch {
      return pino(base);
    }
  }
  return pino(base);
}

export type { Logger };
