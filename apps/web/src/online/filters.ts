// JSON filter builders for the Asset Management list endpoints
// (docs/reference/filtering.txt) and client-side search helpers.

/** Filterable asset fields listed in filtering.txt (other names are ignored by the platform). */
export const ASSET_FILTER_FIELDS = [
  "assetId",
  "tenantId",
  "name",
  "externalId",
  "t2tenant",
  "subTenant",
  "timezone",
  "twinType",
  "deleted",
  "parentId",
  "typeId",
  "fileId",
  "hasType",
] as const;

export type FilterFunction = "eq" | "contains" | "startsWith" | "endsWith";

export type FilterCondition =
  | string
  | null
  | { eq: string | null }
  | { contains: string }
  | { startsWith: string }
  | { endsWith: string }
  | { in: { value: string[] } };

export type FilterSpec = Record<string, FilterCondition | undefined>;

/**
 * Serialise conditions into the `filter` query value. Several fields in one
 * object are combined with "and" (filtering.txt, Operation and). Undefined
 * conditions and empty strings are dropped; returns undefined when nothing remains.
 */
export function buildFilter(spec: FilterSpec): string | undefined {
  const out: Record<string, FilterCondition> = {};
  for (const [field, cond] of Object.entries(spec)) {
    if (cond === undefined) continue;
    if (typeof cond === "string" && cond.trim() === "") continue;
    if (cond && typeof cond === "object" && !("in" in cond) && !("eq" in cond)) {
      const v = Object.values(cond)[0] as string;
      if (v.trim() === "") continue;
    }
    if (cond && typeof cond === "object" && "in" in cond && cond.in.value.length === 0) continue;
    out[field] = cond;
  }
  return Object.keys(out).length ? JSON.stringify(out) : undefined;
}

/** A single-function condition, e.g. textCondition("contains", "Pump"). */
export function textCondition(fn: FilterFunction, value: string): FilterCondition | undefined {
  const v = value.trim();
  if (!v) return undefined;
  switch (fn) {
    case "eq":
      return v;
    case "contains":
      return { contains: v };
    case "startsWith":
      return { startsWith: v };
    case "endsWith":
      return { endsWith: v };
  }
}

export const assetFilters = {
  children: (parentId: string) => buildFilter({ parentId })!,
  ofType: (typeId: string) => buildFilter({ typeId })!,
  /** Assets of the type and of every type derived from it. */
  ofTypeOrDescendants: (typeId: string) => buildFilter({ hasType: typeId })!,
  withFile: (fileId: string) => buildFilter({ fileId })!,
};

/** Case-insensitive "every search term occurs in one of the fields" match. */
export function matchesSearch(query: string, ...fields: (string | null | undefined)[]): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = fields.filter(Boolean).join(" \u0000 ").toLowerCase();
  return terms.every((t) => hay.includes(t));
}
