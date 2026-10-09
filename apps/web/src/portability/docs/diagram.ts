// Relationship diagram: asset type inheritance + aspect type usage.
//
// Layout (for the HTML document's inline SVG): a left-to-right layered tree.
// Columns are inheritance levels (non-project parents such as core.basicasset
// form the first column), rows follow a depth-first pre-order so every type
// sits on its own row — readable for ~100 types without overlaps. Aspect
// types form an extra column on the right, each placed near the mean row of
// the asset types that use it; usage edges are dashed curves drawn beneath the
// nodes.

import type { TypeRef } from "@/domain/model";
import type { DocContext } from "./content";
import { escapeMermaid, escapeXml } from "./escape";

export type DiagramNodeKind = "assetType" | "baseType" | "aspectType";

export interface DiagramNode {
  id: string;
  kind: DiagramNodeKind;
  label: string;
  sub: string;
  /** Extra hint for aspect types (category). */
  tag?: string;
}

export interface DiagramEdge {
  from: string;
  to: string;
  kind: "inherits" | "uses";
  label?: string;
}

export interface DiagramGraph {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

const refId = (prefix: string, ref: TypeRef) => (ref.kind === "project" ? `${prefix}:p:${ref.uid}` : `${prefix}:${ref.kind}:${ref.id}`);
const byName = <T extends { name: string }>(list: T[]) => [...list].sort((a, b) => a.name.localeCompare(b.name));

export function buildDiagramGraph(ctx: DocContext): DiagramGraph {
  const { index, project } = ctx;
  const nodes = new Map<string, DiagramNode>();
  const edges: DiagramEdge[] = [];
  for (const t of byName(project.assetTypes)) {
    const ref: TypeRef = { kind: "project", uid: t.uid };
    nodes.set(refId("at", ref), { id: refId("at", ref), kind: "assetType", label: t.name || t.idSuffix, sub: index.assetTypeDisplayId(ref) });
  }
  for (const t of byName(project.assetTypes)) {
    const child = refId("at", { kind: "project", uid: t.uid });
    const parentKnown = t.parent.kind !== "project" || index.assetTypes.has(t.parent.uid);
    if (!parentKnown) continue;
    const parent = refId("at", t.parent);
    if (!nodes.has(parent)) {
      nodes.set(parent, {
        id: parent,
        kind: "baseType",
        label: index.assetTypeName(t.parent),
        sub: t.parent.kind === "project" ? "" : t.parent.kind === "core" ? t.parent.id : `${t.parent.id} (external)`,
      });
    }
    edges.push({ from: parent, to: child, kind: "inherits" });
  }
  for (const t of byName(project.aspectTypes)) {
    const ref: TypeRef = { kind: "project", uid: t.uid };
    nodes.set(refId("apt", ref), { id: refId("apt", ref), kind: "aspectType", label: t.name || t.idSuffix, sub: index.aspectTypeDisplayId(t), tag: t.category });
  }
  for (const t of byName(project.assetTypes)) {
    const from = refId("at", { kind: "project", uid: t.uid });
    for (const a of t.aspects) {
      const to = refId("apt", a.aspectType);
      if (!nodes.has(to)) {
        const r = index.resolveAspectType(a.aspectType);
        nodes.set(to, {
          id: to,
          kind: "aspectType",
          label: r?.name ?? "(missing aspect type)",
          sub: r?.displayId ?? (a.aspectType.kind === "project" ? "" : a.aspectType.id),
          tag: r ? `${r.category}${r.isCore ? ", core" : r.known ? "" : ", external"}` : undefined,
        });
      }
      edges.push({ from, to, kind: "uses", label: a.name });
    }
  }
  return { nodes: [...nodes.values()], edges };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface PositionedNode extends DiagramNode {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DiagramLayout {
  nodes: PositionedNode[];
  edges: DiagramEdge[];
  width: number;
  height: number;
}

export const NODE_W = 200;
export const NODE_H = 44;
const COL_GAP = 56;
const ROW_GAP = 12;
const ASPECT_GAP = 140;
const PAD = 16;

export function layoutDiagram(graph: DiagramGraph): DiagramLayout {
  const typeNodes = graph.nodes.filter((n) => n.kind !== "aspectType");
  const aspectNodes = graph.nodes.filter((n) => n.kind === "aspectType");
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const e of graph.edges) {
    if (e.kind !== "inherits") continue;
    const list = children.get(e.from) ?? [];
    list.push(e.to);
    children.set(e.from, list);
    hasParent.add(e.to);
  }
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const sortIds = (ids: string[]) => [...ids].sort((a, b) => (byId.get(a)?.label ?? "").localeCompare(byId.get(b)?.label ?? ""));

  const placed = new Map<string, { col: number; row: number }>();
  let row = 0;
  let maxCol = 0;
  const visit = (id: string, col: number) => {
    // Iterative DFS keeps very deep chains safe.
    const stack: { id: string; col: number }[] = [{ id, col }];
    while (stack.length) {
      const cur = stack.pop()!;
      if (placed.has(cur.id)) continue;
      placed.set(cur.id, { col: cur.col, row: row++ });
      maxCol = Math.max(maxCol, cur.col);
      const kids = sortIds(children.get(cur.id) ?? []);
      for (let i = kids.length - 1; i >= 0; i--) stack.push({ id: kids[i]!, col: cur.col + 1 });
    }
  };
  const roots = typeNodes.filter((n) => !hasParent.has(n.id));
  // Base (core / external) types first, then project types without a known parent.
  roots.sort((a, b) => (a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === "baseType" ? -1 : 1));
  for (const r of roots) visit(r.id, 0);
  for (const n of typeNodes) if (!placed.has(n.id)) visit(n.id, 0); // members of cycles

  const xOf = (col: number) => PAD + col * (NODE_W + COL_GAP);
  const yOf = (r: number) => PAD + r * (NODE_H + ROW_GAP);
  const nodes: PositionedNode[] = typeNodes.map((n) => {
    const p = placed.get(n.id)!;
    return { ...n, x: xOf(p.col), y: yOf(p.row), w: NODE_W, h: NODE_H };
  });

  // Aspect type column, ordered by the mean row of their users.
  const aspectX = xOf(maxCol) + NODE_W + ASPECT_GAP;
  const desired = aspectNodes.map((n) => {
    const users = graph.edges.filter((e) => e.kind === "uses" && e.to === n.id).map((e) => placed.get(e.from)?.row ?? 0);
    const mean = users.length ? users.reduce((s, r) => s + r, 0) / users.length : Number.POSITIVE_INFINITY;
    return { n, mean };
  });
  desired.sort((a, b) => a.mean - b.mean || a.n.label.localeCompare(b.n.label));
  let lastY = Number.NEGATIVE_INFINITY;
  const typeCount = typeNodes.length;
  for (const { n, mean } of desired) {
    const want = Number.isFinite(mean) ? yOf(mean) : yOf(typeCount);
    const y = Math.max(want, lastY + NODE_H + ROW_GAP, PAD);
    lastY = y;
    nodes.push({ ...n, x: typeCount ? aspectX : PAD, y, w: NODE_W, h: NODE_H });
  }

  const width = Math.max(...nodes.map((n) => n.x + n.w), 0) + PAD;
  const height = Math.max(...nodes.map((n) => n.y + n.h), 0) + PAD;
  return { nodes, edges: graph.edges, width, height };
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

/** Approximate text fitting for 12px sans-serif (no DOM measuring in a generator). */
function fit(text: string, width: number, charWidth: number): string {
  const max = Math.max(4, Math.floor(width / charWidth));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Colours of the standalone document (not app UI).
const COLORS = {
  assetType: { fill: "rgb(232, 240, 250)", stroke: "rgb(31, 58, 95)" },
  baseType: { fill: "rgb(240, 240, 240)", stroke: "rgb(110, 110, 110)" },
  aspectType: { fill: "rgb(234, 247, 238)", stroke: "rgb(30, 110, 60)" },
  inherits: "rgb(31, 58, 95)",
  uses: "rgb(30, 110, 60)",
  text: "rgb(20, 20, 20)",
  sub: "rgb(90, 90, 90)",
};

export function renderSvg(layout: DiagramLayout, title: string): string {
  const pos = new Map(layout.nodes.map((n) => [n.id, n]));
  const parts: string[] = [];
  const typeCount = layout.nodes.filter((n) => n.kind !== "aspectType").length;
  const aspectCount = layout.nodes.length - typeCount;
  const desc = `${typeCount} asset types and base types, ${aspectCount} aspect types, ${layout.edges.length} relationships.`;
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" class="diagram" role="img" aria-labelledby="diagram-title diagram-desc" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" font-family="Helvetica, Arial, sans-serif">`,
    `<title id="diagram-title">${escapeXml(title)}</title>`,
    `<desc id="diagram-desc">${escapeXml(desc)} The same information is listed in the asset type section.</desc>`,
    `<defs><marker id="arrow-inherits" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${COLORS.inherits}"/></marker>` +
      `<marker id="arrow-uses" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${COLORS.uses}"/></marker></defs>`,
  );
  // Usage edges first (beneath everything).
  for (const e of layout.edges.filter((x) => x.kind === "uses")) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    const dx = Math.max(40, (x2 - x1) / 2);
    parts.push(
      `<path d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2 - 2},${y2}" fill="none" stroke="${COLORS.uses}" stroke-opacity="0.55" stroke-width="1.2" stroke-dasharray="5 4" marker-end="url(#arrow-uses)"><title>${escapeXml(`${a.label} → aspect “${e.label ?? ""}”: ${b.label}`)}</title></path>`,
    );
  }
  for (const e of layout.edges.filter((x) => x.kind === "inherits")) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const xm = x1 + COL_GAP / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    parts.push(
      `<path d="M${x1},${y1} H${xm} V${y2} H${x2 - 2}" fill="none" stroke="${COLORS.inherits}" stroke-width="1.4" marker-end="url(#arrow-inherits)"><title>${escapeXml(`${b.label} inherits from ${a.label}`)}</title></path>`,
    );
  }
  for (const n of layout.nodes) {
    const c = COLORS[n.kind];
    const full = [n.label, n.sub, n.tag].filter(Boolean).join(" — ");
    const subText = [n.sub, n.tag].filter(Boolean).join(" · ");
    parts.push(
      `<g><title>${escapeXml(full)}</title>` +
        `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="6" ry="6" fill="${c.fill}" stroke="${c.stroke}" stroke-width="1.2"${n.kind === "baseType" ? ' stroke-dasharray="4 3"' : ""}/>` +
        `<text x="${n.x + 10}" y="${n.y + 18}" font-size="12" font-weight="bold" fill="${COLORS.text}">${escapeXml(fit(n.label, n.w - 20, 7.2))}</text>` +
        `<text x="${n.x + 10}" y="${n.y + 34}" font-size="10" fill="${COLORS.sub}">${escapeXml(fit(subText, n.w - 20, 5.8))}</text></g>`,
    );
  }
  parts.push("</svg>");
  return parts.join("\n");
}

/** Legend HTML for the SVG (colours match renderSvg). */
export function diagramLegendHtml(): string {
  const item = (label: string, fill: string, stroke: string, dashed = false) =>
    `<li><svg width="28" height="16" aria-hidden="true"><rect x="1" y="1" width="26" height="14" rx="3" fill="${fill}" stroke="${stroke}"${dashed ? ' stroke-dasharray="3 2"' : ""}/></svg>${escapeXml(label)}</li>`;
  const line = (label: string, color: string, dashed: boolean) =>
    `<li><svg width="28" height="16" aria-hidden="true"><line x1="1" y1="8" x2="27" y2="8" stroke="${color}" stroke-width="2"${dashed ? ' stroke-dasharray="4 3"' : ""}/></svg>${escapeXml(label)}</li>`;
  return `<ul class="legend">${[
    item("Project asset type", COLORS.assetType.fill, COLORS.assetType.stroke),
    item("Core / external base type", COLORS.baseType.fill, COLORS.baseType.stroke, true),
    item("Aspect type", COLORS.aspectType.fill, COLORS.aspectType.stroke),
    line("inherits from (parent → child)", COLORS.inherits, false),
    line("uses aspect type", COLORS.uses, true),
  ].join("")}</ul>`;
}

// ---------------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------------

export function renderMermaid(graph: DiagramGraph): string {
  const ids = new Map<string, string>();
  graph.nodes.forEach((n, i) => ids.set(n.id, `n${i + 1}`));
  const lines = ["graph TD"];
  for (const n of graph.nodes) {
    const label = escapeMermaid([n.label, n.sub, n.tag].filter(Boolean).join(" · "));
    const id = ids.get(n.id)!;
    if (n.kind === "aspectType") lines.push(`  ${id}[/"${label}"/]`);
    else if (n.kind === "baseType") lines.push(`  ${id}(["${label}"])`);
    else lines.push(`  ${id}["${label}"]`);
  }
  for (const e of graph.edges) {
    const a = ids.get(e.from);
    const b = ids.get(e.to);
    if (!a || !b) continue;
    if (e.kind === "inherits") lines.push(`  ${a} --> ${b}`);
    else lines.push(`  ${a} -.->|"${escapeMermaid(e.label ?? "")}"| ${b}`);
  }
  return lines.join("\n");
}
