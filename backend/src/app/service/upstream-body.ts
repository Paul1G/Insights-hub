// app/service/upstream-body decodes upstream responses for the AmResponse
// envelope: JSON (incl. application/hal+json and vnd.error+json) is parsed,
// empty bodies become null, anything else is returned as text.

import type { UpstreamResponse } from '../../domain/upstream/transport.js';

const decoder = new TextDecoder('utf-8');

export function decodeBody(res: UpstreamResponse): unknown {
  if (res.body.byteLength === 0) return null;
  const text = decoder.decode(res.body);
  const ct = (res.headers['content-type'] ?? '').toLowerCase();
  const looksJson = ct.includes('json') || /^\s*[[{]/.test(text);
  if (looksJson) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

/** ETag header without weak prefix or quotes ("3" → 3 → "3"). */
export function normaliseEtag(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const v = value
    .trim()
    .replace(/^W\//, '')
    .replace(/^"(.*)"$/, '$1');
  return v === '' ? undefined : v;
}

/** First human-readable message of an AM `errors` body, if any. */
export function upstreamMessage(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return undefined;
  for (const e of errors) {
    if (e !== null && typeof e === 'object') {
      const m = (e as { message?: unknown }).message;
      if (typeof m === 'string' && m.trim() !== '') return m;
    }
  }
  return undefined;
}
