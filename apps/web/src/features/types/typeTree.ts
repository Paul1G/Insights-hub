// Flatten a parent/child forest (asset type inheritance) into indented rows,
// cycle-safe: items in a cycle (or whose parent is missing) become roots.

export interface TreeRow<T> {
  item: T;
  id: string;
  /** 0 for roots. */
  level: number;
  hasChildren: boolean;
  /** Ancestor ids, nearest last. */
  path: string[];
}

export function flattenForest<T>(
  items: T[],
  idOf: (item: T) => string,
  parentOf: (item: T) => string | undefined,
  compare: (a: T, b: T) => number = () => 0,
): TreeRow<T>[] {
  const byId = new Map(items.map((t) => [idOf(t), t]));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const t of items) {
    const parent = parentOf(t);
    if (parent !== undefined && parent !== idOf(t) && byId.has(parent)) {
      const list = children.get(parent) ?? [];
      list.push(t);
      children.set(parent, list);
    } else {
      roots.push(t);
    }
  }
  const out: TreeRow<T>[] = [];
  const visited = new Set<string>();
  const visit = (t: T, level: number, path: string[]) => {
    const id = idOf(t);
    if (visited.has(id)) return;
    visited.add(id);
    const kids = [...(children.get(id) ?? [])].sort(compare);
    out.push({ item: t, id, level, hasChildren: kids.length > 0, path });
    for (const k of kids) visit(k, level + 1, [...path, id]);
  };
  for (const r of [...roots].sort(compare)) visit(r, 0, []);
  // Cycles never reach a root: show them as roots so nothing disappears.
  for (const t of [...items].sort(compare)) if (!visited.has(idOf(t))) visit(t, 0, []);
  return out;
}

/** Keep rows that match plus their ancestors (for context). */
export function filterTreeRows<T>(rows: TreeRow<T>[], matches: (item: T) => boolean): TreeRow<T>[] {
  const keep = new Set<string>();
  for (const r of rows) {
    if (!matches(r.item)) continue;
    keep.add(r.id);
    for (const a of r.path) keep.add(a);
  }
  return rows.filter((r) => keep.has(r.id));
}

/** Case-insensitive "contains" over several fields. */
export function textMatch(query: string, ...fields: (string | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => f !== undefined && f.toLowerCase().includes(q));
}
