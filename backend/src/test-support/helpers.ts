// test-support/helpers: shared fakes for the test suites (excluded from the
// production build).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';

import { SimulatorRegistry } from '../adapter/simulator/registry.js';
import type {
  HttpMethod,
  UpstreamRequest,
  UpstreamResponse,
} from '../domain/upstream/transport.js';
import type { Logger } from '../log.js';
import type { Clock } from '../platform/clock.js';

export const silentLogger: Logger = pino({ level: 'silent' });

export function tempDir(prefix = 'ams-test-'): {
  path: string;
  cleanup: () => void;
} {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}

export class ManualClock implements Clock {
  t: number;
  constructor(start = Date.parse('2026-10-06T08:00:00.000Z')) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function upstreamJson(
  status: number,
  body?: unknown,
  headers: Record<string, string> = {},
): UpstreamResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body:
      body === undefined ? new Uint8Array() : enc.encode(JSON.stringify(body)),
  };
}

export interface SimCallResult {
  status: number;
  headers: Record<string, string>;
  // Response bodies are asserted structurally in tests.
  json: any;
  bytes: Uint8Array;
}

export interface SimCallOptions {
  body?: unknown;
  ifMatch?: string | number;
  ifNoneMatch?: string;
  query?: Record<string, string>;
  contentType?: string;
  form?: () => FormData;
}

/** Drives one simulated tenant directly through its UpstreamTransport. */
export function simHarness(tenant = 'acme'): {
  call: (
    method: HttpMethod,
    path: string,
    o?: SimCallOptions,
  ) => Promise<SimCallResult>;
  registry: SimulatorRegistry;
  dataDir: string;
  connectionId: string;
  cleanup: () => Promise<void>;
} {
  const dir = tempDir('ams-sim-');
  const registry = new SimulatorRegistry({
    dataDir: dir.path,
    logger: silentLogger,
    clock: { now: () => Date.now() },
    sleep: () => Promise.resolve(),
    latencyMs: 0,
  });
  const connectionId = 'conn-1';
  const transport = registry.transport(connectionId, tenant);
  const call = async (
    method: HttpMethod,
    path: string,
    o: SimCallOptions = {},
  ): Promise<SimCallResult> => {
    const headers: Record<string, string> = {};
    if (o.ifMatch !== undefined) headers['if-match'] = String(o.ifMatch);
    if (o.ifNoneMatch !== undefined) headers['if-none-match'] = o.ifNoneMatch;
    const req: UpstreamRequest = { method, path, headers };
    if (o.query) req.query = o.query;
    if (o.form) req.body = { kind: 'multipart', form: o.form };
    else if (o.body !== undefined) {
      req.body = {
        kind: 'json',
        contentType:
          o.contentType ??
          (method === 'PATCH'
            ? 'application/merge-patch+json'
            : 'application/json'),
        text: JSON.stringify(o.body),
      };
    }
    const res = await transport.send(req);
    const text = dec.decode(res.body);
    let json: unknown = undefined;
    if (text !== '' && (res.headers['content-type'] ?? '').includes('json'))
      json = JSON.parse(text);
    return { status: res.status, headers: res.headers, json, bytes: res.body };
  };
  return {
    call,
    registry,
    dataDir: dir.path,
    connectionId,
    cleanup: async () => {
      await registry.flushAll();
      dir.cleanup();
    },
  };
}
