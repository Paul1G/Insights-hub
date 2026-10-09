// adapter/simulator/rules holds the field rules the simulator enforces,
// transcribed from the spec's schemas (patterns, lengths, enums) and the
// documentation in docs/reference/. Value checks mirror
// apps/web/src/domain/values.ts so studio and simulator agree.

import type { DataType } from './model.js';

/** Reserved words that cannot be used as variable or aspect names. */
const RESERVED = new Set(
  [
    'id',
    'name',
    'description',
    'tenant',
    'etag',
    'scope',
    'properties',
    'propertySets',
    'extends',
    'variables',
    'aspects',
    'parentTypeId',
  ].map((w) => w.toLowerCase()),
);

export const isReserved = (name: string): boolean =>
  RESERVED.has(name.toLowerCase());

export const PATTERNS = {
  typeId: /^[A-Za-z0-9_]{1,8}\.[A-Za-z0-9_]+$/,
  aspectTypeName: /^[a-zA-Z0-9_]+$/,
  assetTypeName: /^[\p{L}_0-9. ]+$/u,
  variableName: /^[a-zA-Z_][a-zA-Z0-9_]*$/,
  aspectName: /^[a-zA-Z0-9_]+$/,
  valueName: /^[a-zA-Z0-9_]+$/,
  assetName: /^[^/\\]*$/,
  noSingleQuote: /^[^']*$/,
  fileName: /^[^*&%\s/\\]+$/,
  fileKey: /^\w+$/,
  locality: /^[\p{L}0-9_ \-']*$/u,
  uniqueId: /^[0-9a-fA-F]{32}$/,
} as const;

export const LIMITS = {
  typeIdMax: 128,
  typeNameMax: 128,
  variableNameMax: 64,
  aspectNameMax: 64,
  assetNameMax: 128,
  descriptionMax: 255,
  unitMax: 32,
  stringLengthMax: 255,
  bigStringLengthMax: 100000,
  defaultValueMax: 255,
  valueMax: 255,
  externalIdMax: 255,
  locationFieldMax: 255,
  timezoneMax: 255,
  fileNameMax: 255,
  fileDescriptionMax: 255,
  fileSizeMaxBytes: 5 * 1024 * 1024,
} as const;

export const DEFAULT_STRING_LENGTH = 255;
export const DEFAULT_BIG_STRING_LENGTH = 100000;

export const supportsLength = (t: DataType): boolean =>
  t === 'STRING' || t === 'BIG_STRING';

const INT_MIN = -(2 ** 31);
const INT_MAX = 2 ** 31 - 1;
const LONG_MIN = -(2n ** 63n);
const LONG_MAX = 2n ** 63n - 1n;
const INTEGER = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;

/** Returns an error message, or undefined when `value` fits `dataType`. */
export function checkValue(
  dataType: DataType,
  value: string,
  length: number | null,
): string | undefined {
  if (value.length < 1) return 'value must not be empty';
  if (value.length > LIMITS.valueMax)
    return `value is longer than ${LIMITS.valueMax} characters`;
  switch (dataType) {
    case 'BOOLEAN':
      return value === 'true' || value === 'false'
        ? undefined
        : 'expected "true" or "false"';
    case 'INT': {
      if (!INTEGER.test(value)) return 'expected a whole number (INT)';
      const n = Number(value);
      return n < INT_MIN || n > INT_MAX ? 'out of INT range' : undefined;
    }
    case 'LONG': {
      if (!INTEGER.test(value)) return 'expected a whole number (LONG)';
      const n = BigInt(value);
      return n < LONG_MIN || n > LONG_MAX ? 'out of LONG range' : undefined;
    }
    case 'DOUBLE':
      return DECIMAL.test(value) && Number.isFinite(Number(value))
        ? undefined
        : 'expected a number (DOUBLE)';
    case 'TIMESTAMP':
      return ISO_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value))
        ? undefined
        : 'expected an ISO-8601 timestamp, e.g. 2018-01-01T00:00:00.00Z';
    case 'STRING':
    case 'BIG_STRING': {
      const max = length ?? DEFAULT_STRING_LENGTH;
      return value.length > max
        ? `longer than the variable length (${max})`
        : undefined;
    }
  }
}

/** Java/IANA zone id without 15/45-minute offsets (schema `timezone`). */
export function checkTimezone(tz: string): string | undefined {
  if (tz.trim() === '' || tz.length > LIMITS.timezoneMax)
    return 'timezone is invalid';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    return `"${tz}" is not a known time zone id`;
  }
  const year = new Date().getUTCFullYear();
  for (let month = 0; month < 12; month++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'longOffset',
      year: 'numeric',
    }).formatToParts(new Date(Date.UTC(year, month, 15, 12)));
    const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    const m = /^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(name);
    if (m && Number(m[3] ?? '0') % 30 !== 0) {
      return `time zones that are 15 or 45 minutes off a UTC hour are not supported ("${tz}")`;
    }
  }
  return undefined;
}

/** RFC 7396 JSON merge patch. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch))
    return patch;
  const base: Record<string, unknown> =
    target !== null && typeof target === 'object' && !Array.isArray(target)
      ? { ...(target as Record<string, unknown>) }
      : {};
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === null) delete base[k];
    else base[k] = mergePatch(base[k], v);
  }
  return base;
}

/** Strips W/ and quotes from an ETag-ish header value. */
export function parseEtagHeader(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const s = v
    .trim()
    .replace(/^W\//, '')
    .replace(/^"(.*)"$/, '$1');
  return s === '' ? undefined : s;
}
