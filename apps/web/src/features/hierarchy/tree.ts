// Pure tree logic for the hierarchy editor: sorted child lists (built once per
// project revision), flattening of the expanded part of the tree for the
// virtualised list, search (matches + their ancestors) and keyboard moves.
//
// Everything here is O(n) in the number of assets or better, so a 10,000+
// asset hierarchy stays interactive.

import { ROOT_ASSET_UID, type AssetDef } from "@/domain/model";
import type { ModelIndex } from "@/domain/resolve";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export interface TreeStructure {
  /** Sorted child uids per parent uid (natural, case-insensitive name order). */
  children: Map<string, string[]>;
  /**
   * Assets whose parent chain does not reach the root (missing parent or a
   * cycle). They are shown as extra top-level rows so they stay editable.
   */
  detached: string[];
}

function sortedChildUids(list: AssetDef[]): string[] {
  return [...list].sort((a, b) => collator.compare(a.name, b.name) || a.uid.localeCompare(b.uid)).map((a) => a.uid);
}

/** Build the sorted child lists once per project revision. */
export function buildTreeStructure(index: ModelIndex): TreeStructure {
  const children = new Map<string, string[]>();
  for (const a of index.project.assets) {
    const kids = index.childrenOf(a.uid);
    if (kids.length) children.set(a.uid, sortedChildUids(kids));
  }
  // Topmost assets of detached chains: no parent / missing parent. Their
  // subtrees hang below them.
  const unattached = index.project.assets.filter((a) => a.uid !== ROOT_ASSET_UID && !index.isAttached(a.uid));
  const detached: string[] = [];
  const covered = new Set<string>();
  const cover = (uid: string) => {
    covered.add(uid);
    for (const d of index.descendantsOf(uid)) covered.add(d);
  };
  for (const a of unattached) {
    if (a.parentUid === null || !index.assets.has(a.parentUid)) {
      detached.push(a.uid);
      cover(a.uid);
    }
  }
  // Members of parent cycles have no topmost asset: pick one per cycle.
  for (const a of unattached) {
    if (covered.has(a.uid)) continue;
    detached.push(a.uid);
    cover(a.uid);
  }
  detached.sort((x, y) => collator.compare(index.assets.get(x)?.name ?? "", index.assets.get(y)?.name ?? ""));
  return { children, detached };
}

export interface TreeRow {
  uid: string;
  /** 0-based depth (root = 0). aria-level is depth + 1. */
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  /** 1-based position among the visible siblings and their count (aria-posinset / aria-setsize). */
  posInSet: number;
  setSize: number;
  /** Row index of the parent row, -1 for top-level rows. */
  parentRow: number;
  detached: boolean;
}

export interface FlattenOptions {
  isExpanded: (uid: string) => boolean;
  /** When set (search mode), only these uids are shown. */
  visible?: Set<string>;
}

/** Flatten the visible part of the tree (only expanded nodes are descended into). */
export function flattenTree(structure: TreeStructure, opts: FlattenOptions): TreeRow[] {
  const rows: TreeRow[] = [];
  const seen = new Set<string>();
  const { visible } = opts;
  const kidsOf = (uid: string): string[] => {
    const all = structure.children.get(uid) ?? [];
    return visible ? all.filter((c) => visible.has(c)) : all;
  };

  const tops = [ROOT_ASSET_UID, ...structure.detached].filter((u) => !visible || visible.has(u));
  // Explicit stack: [uid, depth, parentRow, posInSet, setSize, detached]
  type Frame = [string, number, number, number, number, boolean];
  const stack: Frame[] = [];
  for (let i = tops.length - 1; i >= 0; i--) stack.push([tops[i]!, 0, -1, i + 1, tops.length, tops[i] !== ROOT_ASSET_UID]);

  while (stack.length) {
    const [uid, depth, parentRow, posInSet, setSize, detached] = stack.pop()!;
    if (seen.has(uid)) continue;
    seen.add(uid);
    const kids = kidsOf(uid).filter((k) => !seen.has(k));
    const hasChildren = kids.length > 0;
    const expanded = hasChildren && opts.isExpanded(uid);
    const rowIndex = rows.length;
    rows.push({ uid, depth, hasChildren, expanded, posInSet, setSize, parentRow, detached });
    if (expanded) {
      for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i]!, depth + 1, rowIndex, i + 1, kids.length, detached]);
    }
  }
  return rows;
}

export interface SearchResult {
  /** Assets whose name or external id contains the query. */
  matches: Set<string>;
  /** Strict ancestors of matches (auto-expanded in search mode). */
  ancestors: Set<string>;
  /** matches ∪ ancestors. */
  visible: Set<string>;
}

export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

/** Find matching assets (case-insensitive substring on name and externalId) plus their ancestors. */
export function searchTree(index: ModelIndex, query: string): SearchResult {
  const q = normalizeQuery(query);
  const matches = new Set<string>();
  const ancestors = new Set<string>();
  if (!q) return { matches, ancestors, visible: new Set() };
  for (const a of index.project.assets) {
    if (a.name.toLowerCase().includes(q) || (a.externalId ?? "").toLowerCase().includes(q)) matches.add(a.uid);
  }
  for (const uid of matches) {
    let cur = index.assets.get(uid);
    const guard = new Set<string>([uid]);
    while (cur && cur.parentUid !== null) {
      const parent = cur.parentUid;
      if (ancestors.has(parent) || guard.has(parent)) break;
      guard.add(parent);
      ancestors.add(parent);
      cur = index.assets.get(parent);
    }
  }
  const visible = new Set<string>([...matches, ...ancestors]);
  return { matches, ancestors, visible };
}

/** Split a label into parts for highlighting the (case-insensitive) query. */
export function highlightParts(text: string, query: string): { text: string; match: boolean }[] {
  const q = normalizeQuery(query);
  if (!q) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const out: { text: string; match: boolean }[] = [];
  let pos = 0;
  for (;;) {
    const hit = lower.indexOf(q, pos);
    if (hit < 0) break;
    if (hit > pos) out.push({ text: text.slice(pos, hit), match: false });
    out.push({ text: text.slice(hit, hit + q.length), match: true });
    pos = hit + q.length;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), match: false });
  return out.length ? out : [{ text, match: false }];
}

export type TreeKeyAction =
  | { type: "focus"; row: number }
  | { type: "expand"; uid: string }
  | { type: "collapse"; uid: string }
  | { type: "select"; row: number }
  | { type: "none" };

/** WAI-ARIA tree keyboard model for the flattened rows. */
export function treeKeyAction(rows: TreeRow[], current: number, key: string, pageSize = 10): TreeKeyAction {
  if (rows.length === 0) return { type: "none" };
  const i = Math.min(Math.max(current, 0), rows.length - 1);
  const row = rows[i]!;
  switch (key) {
    case "ArrowDown":
      return { type: "focus", row: Math.min(rows.length - 1, i + 1) };
    case "ArrowUp":
      return { type: "focus", row: Math.max(0, i - 1) };
    case "Home":
      return { type: "focus", row: 0 };
    case "End":
      return { type: "focus", row: rows.length - 1 };
    case "PageDown":
      return { type: "focus", row: Math.min(rows.length - 1, i + pageSize) };
    case "PageUp":
      return { type: "focus", row: Math.max(0, i - pageSize) };
    case "ArrowRight":
      if (row.hasChildren && !row.expanded) return { type: "expand", uid: row.uid };
      if (row.expanded && i + 1 < rows.length) return { type: "focus", row: i + 1 };
      return { type: "none" };
    case "ArrowLeft":
      if (row.expanded) return { type: "collapse", uid: row.uid };
      if (row.parentRow >= 0) return { type: "focus", row: row.parentRow };
      return { type: "none" };
    case "Enter":
    case " ":
      return { type: "select", row: i };
    default:
      return { type: "none" };
  }
}

/** All uids that have children (for "Expand all"). */
export function allParents(structure: TreeStructure): Set<string> {
  return new Set(structure.children.keys());
}

/** Ancestor uids of an asset (root first), used to reveal a selected asset. */
export function ancestorUids(index: ModelIndex, uid: string): string[] {
  return index
    .hierarchyPath(uid)
    .slice(0, -1)
    .map((a) => a.uid);
}
