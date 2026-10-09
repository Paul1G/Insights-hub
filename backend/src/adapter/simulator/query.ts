// adapter/simulator/query implements list query semantics from
// docs/reference/filtering.txt and pagination.txt:
//
//   filter — JSON: {"field": value} (eq) or {"field": {fn: arg}} with
//     fn ∈ eq, in ({"value": [...]}), startsWith, endsWith, contains,
//     before, after, between ("[a, b)"), plus field-level "or"/"and" arrays
//     and "not"; operations "and"/"or" (object or array) and "not" on the
//     top level; several keys are AND-ed. Unknown field names are ignored
//     (the documentation: "all other field names will be ignored").
//     Special field hasType is resolved through a callback.
//   sort — "field" or "field,asc|desc"; default name ascending.
//   page/size — default page 0, size 10.

import { badRequest } from './sim-error.js';

export type FieldGetter<T> = (item: T, field: string) => unknown;

export interface QuerySpec<T> {
  /** Filterable/sortable field names. */
  fields: readonly string[];
  get: FieldGetter<T>;
  /** Special fields such as hasType, evaluated against the raw condition. */
  special?: Record<string, (cond: unknown) => (item: T) => boolean>;
}

type Predicate<T> = (item: T) => boolean;

const FUNCTIONS = new Set([
  'eq',
  'in',
  'startsWith',
  'endsWith',
  'contains',
  'before',
  'after',
  'between',
  'or',
  'and',
  'not',
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Text form of a scalar for comparisons (objects compare as JSON). */
function scalarText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint')
    return String(v);
  return JSON.stringify(v) ?? '';
}

function equals(actual: unknown, expected: unknown): boolean {
  if (expected === null) return actual === null || actual === undefined;
  if (actual === null || actual === undefined) return false;
  if (typeof actual === 'string' && typeof expected === 'string')
    return actual === expected;
  return scalarText(actual) === scalarText(expected);
}

function toTime(v: unknown, what: string): number {
  if (typeof v !== 'string')
    throw badRequest(`Invalid filter: ${what} expects a timestamp`);
  const t = Date.parse(v);
  if (Number.isNaN(t))
    throw badRequest(`Invalid filter: "${v}" is not a timestamp`);
  return t;
}

function asText(actual: unknown): string | undefined {
  if (actual === null || actual === undefined) return undefined;
  return scalarText(actual);
}

export function fieldCondition(cond: unknown): (actual: unknown) => boolean {
  if (!isObject(cond)) {
    if (Array.isArray(cond))
      throw badRequest(
        'Invalid filter: arrays are only allowed in "in", "or" and "and"',
      );
    return (actual) => equals(actual, cond);
  }
  const parts: ((actual: unknown) => boolean)[] = [];
  for (const [fn, arg] of Object.entries(cond)) {
    if (!FUNCTIONS.has(fn))
      throw badRequest(`Invalid filter: unknown function "${fn}"`);
    switch (fn) {
      case 'eq':
        parts.push((a) => equals(a, arg));
        break;
      case 'in': {
        const values = isObject(arg) ? arg.value : arg;
        if (!Array.isArray(values))
          throw badRequest('Invalid filter: "in" expects {"value": [...]}');
        parts.push((a) => values.some((v) => equals(a, v)));
        break;
      }
      case 'startsWith':
      case 'endsWith':
      case 'contains': {
        if (typeof arg !== 'string')
          throw badRequest(`Invalid filter: "${fn}" expects a string`);
        parts.push((a) => {
          const s = asText(a);
          if (s === undefined) return false;
          if (fn === 'startsWith') return s.startsWith(arg);
          if (fn === 'endsWith') return s.endsWith(arg);
          return s.includes(arg);
        });
        break;
      }
      case 'before':
      case 'after': {
        const t = toTime(arg, fn);
        parts.push((a) => {
          if (typeof a !== 'string') return false;
          const at = Date.parse(a);
          return !Number.isNaN(at) && (fn === 'before' ? at < t : at > t);
        });
        break;
      }
      case 'between': {
        if (typeof arg !== 'string')
          throw badRequest('Invalid filter: "between" expects "[from, to)"');
        const m = /^\s*([[(])\s*([^,]+?)\s*,\s*([^,]+?)\s*([\])])\s*$/.exec(
          arg,
        );
        if (!m)
          throw badRequest('Invalid filter: "between" expects "[from, to)"');
        const from = toTime(m[2], 'between');
        const to = toTime(m[3], 'between');
        const lowIncl = m[1] === '[';
        const highIncl = m[4] === ']';
        parts.push((a) => {
          if (typeof a !== 'string') return false;
          const at = Date.parse(a);
          if (Number.isNaN(at)) return false;
          return (
            (lowIncl ? at >= from : at > from) &&
            (highIncl ? at <= to : at < to)
          );
        });
        break;
      }
      case 'or':
      case 'and': {
        if (!Array.isArray(arg))
          throw badRequest(
            `Invalid filter: field-level "${fn}" expects an array`,
          );
        const subs = arg.map(fieldCondition);
        parts.push(
          fn === 'or'
            ? (a) => subs.some((s) => s(a))
            : (a) => subs.every((s) => s(a)),
        );
        break;
      }
      case 'not': {
        const sub = fieldCondition(arg);
        parts.push((a) => !sub(a));
        break;
      }
    }
  }
  return (actual) => parts.every((p) => p(actual));
}

function compile<T>(filter: unknown, spec: QuerySpec<T>): Predicate<T> {
  if (!isObject(filter))
    throw badRequest('Invalid filter: expected a JSON object');
  const parts: Predicate<T>[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (key === 'and' || key === 'or') {
      let subs: Predicate<T>[];
      if (Array.isArray(value)) {
        subs = value.map((v) => compile(v, spec));
      } else if (isObject(value)) {
        subs = Object.entries(value).map(([k, v]) => compile({ [k]: v }, spec));
      } else {
        throw badRequest(`Invalid filter: "${key}" expects an object or array`);
      }
      parts.push(
        key === 'or'
          ? (i) => subs.some((s) => s(i))
          : (i) => subs.every((s) => s(i)),
      );
      continue;
    }
    if (key === 'not') {
      const sub = compile(value, spec);
      parts.push((i) => !sub(i));
      continue;
    }
    const special = spec.special?.[key];
    if (special) {
      parts.push(special(value));
      continue;
    }
    if (!spec.fields.includes(key)) continue; // ignored per documentation
    const cond = fieldCondition(value);
    parts.push((i) => cond(spec.get(i, key)));
  }
  return (i) => parts.every((p) => p(i));
}

export function applyFilter<T>(
  items: readonly T[],
  raw: string | undefined,
  spec: QuerySpec<T>,
): T[] {
  if (raw === undefined || raw.trim() === '') return [...items];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw badRequest('Invalid filter: not valid JSON');
  }
  const pred = compile(parsed, spec);
  return items.filter(pred);
}

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean')
    return a === b ? 0 : a ? 1 : -1;
  const sa = scalarText(a);
  const sb = scalarText(b);
  const la = sa.toLowerCase();
  const lb = sb.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export function applySort<T>(
  items: T[],
  raw: string | undefined,
  spec: QuerySpec<T>,
  tieBreak: (item: T) => string,
): T[] {
  let field = 'name';
  let desc = false;
  if (raw !== undefined && raw.trim() !== '') {
    const [f, dir, ...rest] = raw.split(',').map((s) => s.trim());
    if (
      !f ||
      rest.length > 0 ||
      (dir !== undefined && dir !== 'asc' && dir !== 'desc')
    ) {
      throw badRequest(`Invalid sort "${raw}"`);
    }
    if (!spec.fields.includes(f))
      throw badRequest(`Sorting by "${f}" is not supported`);
    field = f;
    desc = dir === 'desc';
  }
  const sign = desc ? -1 : 1;
  return [...items].sort(
    (a, b) =>
      sign * compareValues(spec.get(a, field), spec.get(b, field)) ||
      compareValues(tieBreak(a), tieBreak(b)),
  );
}

export interface PageParams {
  page: number;
  size: number;
}

export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 2000;

function intParam(
  name: string,
  raw: string | undefined,
  def: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw === '') return def;
  if (!/^\d+$/.test(raw))
    throw badRequest(`Parameter ${name} must be a non-negative integer`);
  const n = Number(raw);
  if (n < min || n > max)
    throw badRequest(`Parameter ${name} must be between ${min} and ${max}`);
  return n;
}

export function pageParams(query: Record<string, string>): PageParams {
  return {
    page: intParam('page', query.page, 0, 0, Number.MAX_SAFE_INTEGER),
    size: intParam('size', query.size, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
  };
}

export interface HalPage {
  _embedded: Record<string, unknown[]>;
  page: {
    size: number;
    totalElements: number;
    totalPages: number;
    number: number;
  };
  _links: Record<string, { href: string }>;
}

/** Builds a HAL page; only the requested slice is rendered. */
export function halPage<T>(
  items: readonly T[],
  embeddedKey: string,
  p: PageParams,
  selfHref: string,
  render: (item: T) => unknown = (item) => item,
): HalPage {
  const totalElements = items.length;
  const totalPages = Math.ceil(totalElements / p.size);
  const start = p.page * p.size;
  const slice = items.slice(start, start + p.size).map(render);
  const link = (page: number) => ({
    href: `${selfHref}${selfHref.includes('?') ? '&' : '?'}page=${page}&size=${p.size}`,
  });
  const links: Record<string, { href: string }> = { self: link(p.page) };
  if (totalPages > 0) {
    links.first = link(0);
    links.last = link(totalPages - 1);
  }
  if (p.page > 0 && totalPages > 0)
    links.prev = link(Math.min(p.page - 1, totalPages - 1));
  if (p.page + 1 < totalPages) links.next = link(p.page + 1);
  return {
    _embedded: { [embeddedKey]: slice },
    page: { size: p.size, totalElements, totalPages, number: p.page },
    _links: links,
  };
}
