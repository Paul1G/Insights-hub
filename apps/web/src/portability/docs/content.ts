// Format-independent documentation content, shared by the Markdown, HTML and
// PDF renderers. Everything is derived from the domain layer (ModelIndex,
// validator, estimator) so the documentation matches what the editors show.

import type { CoreLibrary, CoreLibraryIndex } from "@/domain/coreLibrary";
import { breakdownFor, estimateProject, type ProjectEstimate, type TypeEstimate } from "@/domain/estimator";
import {
  ROOT_ASSET_UID,
  type AspectTypeDef,
  type AssetTypeDef,
  type ChangeLogEntry,
  type FileDef,
  type Project,
  type VariableDef,
} from "@/domain/model";
import { ModelIndex, type ResolvedAspect, type ResolvedVariable, type VariableLike } from "@/domain/resolve";
import { DEFAULT_GUARDRAILS, GUARDRAIL_NOTES, TECHNICAL_LIMITS, type GuardrailSettings } from "@/domain/rules";
import { validateProject, type Issue, type ValidationResult } from "@/domain/validator";

export interface DocContext {
  project: Project;
  index: ModelIndex;
  validation: ValidationResult;
  estimate: ProjectEstimate;
  guardrails: GuardrailSettings;
  generatedAt: Date;
}

export function buildDocContext(
  project: Project,
  core: CoreLibrary | CoreLibraryIndex,
  guardrails: GuardrailSettings = DEFAULT_GUARDRAILS,
  generatedAt: Date = new Date(),
): DocContext {
  const index = new ModelIndex(project, core);
  return {
    project,
    index,
    validation: validateProject(index, guardrails),
    estimate: estimateProject(index),
    guardrails,
    generatedAt,
  };
}

/** A simple table: header labels + rows of display strings. */
export interface DocTable {
  headers: string[];
  rows: string[][];
}

const yesNo = (b: boolean | undefined) => (b ? "yes" : "no");
const dash = (s: string | number | null | undefined) => (s === undefined || s === null || s === "" ? "—" : String(s));
const byName = <T extends { name: string }>(list: T[]) => [...list].sort((a, b) => a.name.localeCompare(b.name));

export function formatDateTime(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

export function formatInt(n: number): string {
  return n.toLocaleString("en-US");
}

// ---------------------------------------------------------------------------
// Metadata & summary
// ---------------------------------------------------------------------------

export function metadataTable(ctx: DocContext): DocTable {
  const p = ctx.project;
  return {
    headers: ["Property", "Value"],
    rows: [
      ["Project", p.name],
      ["Description", dash(p.description)],
      ["Created", formatDateTime(p.createdAt)],
      ["Last modified", formatDateTime(p.updatedAt)],
      ["Schema version", String(p.schemaVersion)],
      ["Core library", ctx.index.core.library.source === "tenant" ? `Synced from tenant${ctx.index.core.library.syncedFrom ? ` (${ctx.index.core.library.syncedFrom})` : ""}` : "Built-in"],
      ["Generated", formatDateTime(ctx.generatedAt)],
      ["Generator", "Asset Model Studio"],
    ],
  };
}

export interface SummaryData {
  counts: DocTable;
  attributes: DocTable;
  perType: DocTable;
  validation: DocTable;
  issues: Issue[];
  omittedIssues: number;
  estimateNote: string;
}

export const MAX_LISTED_ISSUES = 100;

export function summaryData(ctx: DocContext): SummaryData {
  const p = ctx.project;
  const e = ctx.estimate;
  const v = ctx.validation;
  const types: TypeEstimate[] = e.types.filter((t) => t.instances > 0 || t.ref.kind === "project");
  const listed = v.issues.filter((i) => i.severity !== "info");
  return {
    counts: {
      headers: ["Item", "Count"],
      rows: [
        ["Aspect types", formatInt(p.aspectTypes.length)],
        ["Asset types", formatInt(p.assetTypes.length)],
        ["Assets (without tenant root)", formatInt(p.assets.filter((a) => a.uid !== ROOT_ASSET_UID).length)],
        ["Files", formatInt(p.files.length)],
      ],
    },
    attributes: {
      headers: ["Measure", "Value"],
      rows: [
        ["Estimated asset attributes", `${formatInt(e.totalAttributes)}${e.incomplete ? " (lower bound)" : ""}`],
        ["Share of the per-tenant technical limit", `${(e.tenantLimitShare * 100).toFixed(2)} % of ${formatInt(TECHNICAL_LIMITS.maxAttributesPerTenant)}`],
        ["Assets of OOTB (core) types", formatInt(e.ootbInstances)],
      ],
    },
    perType: {
      headers: ["Asset type", "Id", "Attributes per asset", "Instances", "Total attributes"],
      rows: types.map((t) => [
        t.name,
        t.displayId,
        `${formatInt(t.perAsset)}${t.incomplete ? " (≥)" : ""}`,
        formatInt(t.instances),
        formatInt(t.totalAttributes),
      ]),
    },
    validation: {
      headers: ["Severity", "Count"],
      rows: [
        ["Errors", formatInt(v.errors)],
        ["Warnings", formatInt(v.warnings)],
        ["Information", formatInt(v.infos)],
      ],
    },
    issues: listed.slice(0, MAX_LISTED_ISSUES),
    omittedIssues: Math.max(0, listed.length - MAX_LISTED_ISSUES),
    estimateNote: GUARDRAIL_NOTES.attributes,
  };
}

export function issueTable(issues: Issue[]): DocTable {
  return {
    headers: ["Severity", "Entity", "Message"],
    rows: issues.map((i) => [i.severity, i.target.label, i.hint ? `${i.message} ${i.hint}` : i.message]),
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const VARIABLE_HEADERS = ["Name", "Data type", "Unit", "Length", "Searchable", "Default", "Quality code"];

export function variableRow(v: VariableDef | VariableLike): string[] {
  return [
    v.name,
    v.dataType,
    dash(v.unit),
    dash(v.length),
    yesNo(v.searchable),
    dash(v.defaultValue),
    v.qualityCode === undefined ? "—" : yesNo(v.qualityCode),
  ];
}

export function variableTable(vars: (VariableDef | VariableLike)[]): DocTable {
  return { headers: VARIABLE_HEADERS, rows: vars.map(variableRow) };
}

export interface AspectTypeDoc {
  def: AspectTypeDef;
  displayId: string;
  usedBy: string[];
  properties: DocTable;
  variables: DocTable;
}

export function aspectTypeDocs(ctx: DocContext): AspectTypeDoc[] {
  return byName(ctx.project.aspectTypes).map((def) => {
    const usedBy = ctx.index.aspectTypeUsage(def.uid).map((u) => `${u.assetType.name}.${u.aspectName}`);
    const displayId = ctx.index.aspectTypeDisplayId(def);
    return {
      def,
      displayId,
      usedBy,
      properties: {
        headers: ["Property", "Value"],
        rows: [
          ["Id", displayId],
          ["Category", def.category],
          ["Description", dash(def.description)],
          ["Used by", usedBy.length ? usedBy.join(", ") : "not used"],
          ...(def.notes ? [["Notes", def.notes]] : []),
        ],
      },
      variables: variableTable(def.variables),
    };
  });
}

export interface AssetTypeDoc {
  def: AssetTypeDef;
  displayId: string;
  properties: DocTable;
  ownVariables: DocTable;
  inheritedVariables: DocTable;
  aspects: DocTable;
}

function chainLabel(ctx: DocContext, t: AssetTypeDef): string {
  const r = ctx.index.resolveAssetType({ kind: "project", uid: t.uid });
  if (!r) return "—";
  const names = r.chain.map((ref) => `${ctx.index.assetTypeName(ref)} (${ctx.index.assetTypeDisplayId(ref)})`);
  const suffix = r.cyclic ? " … (cyclic)" : r.unresolved.length ? " … (continues in the target tenant)" : "";
  return [...names].reverse().join(" → ") + suffix;
}

function inheritedRow(v: ResolvedVariable): string[] {
  return [...variableRow(v), v.definedOnName];
}

function aspectRow(a: ResolvedAspect): string[] {
  return [
    a.name,
    `${a.aspectType.name} (${a.aspectType.displayId})`,
    a.aspectType.category,
    a.aspectType.known ? String(a.aspectType.variables.length) : "unknown",
    a.inherited ? a.definedOnName : "own",
  ];
}

export function assetTypeDocs(ctx: DocContext): AssetTypeDoc[] {
  return byName(ctx.project.assetTypes).map((def) => {
    const ref = { kind: "project" as const, uid: def.uid };
    const r = ctx.index.resolveAssetType(ref);
    const breakdown = r ? breakdownFor(r) : undefined;
    const instances = ctx.index.assetsOfType(ref, false).length;
    const displayId = ctx.index.assetTypeDisplayId(ref);
    const children = ctx.index.childTypesOf(def.uid).map((c) => c.name);
    return {
      def,
      displayId,
      properties: {
        headers: ["Property", "Value"],
        rows: [
          ["Id", displayId],
          ["Parent", `${ctx.index.assetTypeName(def.parent)} (${ctx.index.assetTypeDisplayId(def.parent)})`],
          ["Inheritance chain", chainLabel(ctx, def)],
          ["Inheritance depth", r ? String(r.depth) : "—"],
          ["Instantiable", yesNo(def.instantiable)],
          ["Child types", children.length ? children.sort().join(", ") : "none"],
          ["Description", dash(def.description)],
          [
            "Asset attributes per asset",
            breakdown ? `${formatInt(breakdown.perAsset)}${breakdown.incomplete ? " (lower bound)" : ""}` : "—",
          ],
          ["Instances in the project", formatInt(instances)],
          ...(def.notes ? [["Notes", def.notes]] : []),
        ],
      },
      ownVariables: variableTable(def.variables),
      inheritedVariables: {
        headers: [...VARIABLE_HEADERS, "Defined on"],
        rows: (r?.variables ?? []).filter((v) => v.inherited).map(inheritedRow),
      },
      aspects: {
        headers: ["Aspect", "Aspect type", "Category", "Variables", "Defined on"],
        rows: (r?.aspects ?? []).map(aspectRow),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Inheritance tree (text form, used by the PDF)
// ---------------------------------------------------------------------------

export interface InheritanceLine {
  depth: number;
  name: string;
  id: string;
  kind: "project" | "core" | "external";
  aspects: string[];
}

/** Project asset types as an indented tree under their non-project ancestors. */
export function inheritanceLines(ctx: DocContext): InheritanceLine[] {
  const { index, project } = ctx;
  const out: InheritanceLine[] = [];
  const visited = new Set<string>();
  const aspectsOf = (t: AssetTypeDef) => t.aspects.map((a) => `${a.name}: ${index.resolveAspectType(a.aspectType)?.name ?? "(missing)"}`);
  const visit = (t: AssetTypeDef, depth: number) => {
    if (visited.has(t.uid)) return;
    visited.add(t.uid);
    out.push({ depth, name: t.name, id: index.assetTypeDisplayId({ kind: "project", uid: t.uid }), kind: "project", aspects: aspectsOf(t) });
    for (const c of byName(index.childTypesOf(t.uid))) visit(c, depth + 1);
  };
  const roots = new Map<string, AssetTypeDef[]>();
  for (const t of byName(project.assetTypes)) {
    if (t.parent.kind === "project" && index.assetTypes.has(t.parent.uid)) continue;
    const key = t.parent.kind === "project" ? `(missing parent)` : t.parent.id;
    const list = roots.get(key) ?? [];
    list.push(t);
    roots.set(key, list);
  }
  for (const [key, list] of [...roots.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const first = list[0]!;
    const kind = first.parent.kind === "core" ? "core" : first.parent.kind === "external" ? "external" : "project";
    out.push({ depth: 0, name: first.parent.kind === "project" ? key : index.assetTypeName(first.parent), id: key, kind, aspects: [] });
    for (const t of list) visit(t, 1);
  }
  // Types in parent cycles are not reachable from a root.
  for (const t of byName(project.assetTypes)) if (!visited.has(t.uid)) visit(t, 0);
  return out;
}

// ---------------------------------------------------------------------------
// Asset hierarchy
// ---------------------------------------------------------------------------

export interface HierarchyLine {
  depth: number;
  uid: string;
  name: string;
  typeName: string;
  /** Children not listed because of the depth cap. */
  hiddenChildren: number;
}

export interface HierarchyDoc {
  lines: HierarchyLine[];
  total: number;
  omitted: number;
  /** Assets whose parent chain does not reach the root. */
  detached: number;
  maxNodes: number;
  maxDepth: number;
}

export function hierarchyDoc(ctx: DocContext, maxNodes: number, maxDepth: number): HierarchyDoc {
  const { index, project } = ctx;
  const lines: HierarchyLine[] = [];
  const total = project.assets.filter((a) => a.uid !== ROOT_ASSET_UID).length;
  const root = index.root;
  let listed = 0;
  if (root) {
    lines.push({ depth: 0, uid: root.uid, name: root.name, typeName: index.assetTypeName(root.type), hiddenChildren: 0 });
    const seen = new Set<string>([root.uid]);
    const stack: { uid: string; depth: number }[] = byName(index.childrenOf(root.uid))
      .reverse()
      .map((a) => ({ uid: a.uid, depth: 1 }));
    while (stack.length && listed < maxNodes) {
      const { uid, depth } = stack.pop()!;
      if (seen.has(uid)) continue;
      seen.add(uid);
      const a = index.assets.get(uid)!;
      const kids = byName(index.childrenOf(uid));
      const hidden = depth >= maxDepth ? index.descendantsOf(uid).length : 0;
      lines.push({ depth, uid, name: a.name, typeName: index.assetTypeName(a.type), hiddenChildren: hidden });
      listed++;
      if (depth < maxDepth) for (let i = kids.length - 1; i >= 0; i--) stack.push({ uid: kids[i]!.uid, depth: depth + 1 });
    }
  }
  const detached = project.assets.filter((a) => a.uid !== ROOT_ASSET_UID && !index.isAttached(a.uid)).length;
  return {
    lines,
    total,
    omitted: Math.max(0, total - listed),
    detached,
    maxNodes,
    maxDepth,
  };
}

export function hierarchyOmissionNote(h: HierarchyDoc): string | undefined {
  if (h.omitted === 0) return undefined;
  const parts = [`${formatInt(h.omitted)} of ${formatInt(h.total)} assets are not listed`];
  parts.push(`(limits: ${formatInt(h.maxNodes)} assets, ${h.maxDepth} levels below the tenant root`);
  return `${parts.join(" ")}${h.detached ? `; ${formatInt(h.detached)} assets are not attached to the root` : ""}).`;
}

// ---------------------------------------------------------------------------
// Files, change log, guardrails
// ---------------------------------------------------------------------------

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function filesTable(ctx: DocContext): DocTable {
  const rows = byName(ctx.project.files).map((f: FileDef) => {
    const usage = ctx.index.fileUsage(f.uid);
    const used = [
      ...usage.assetTypes.map((t) => `type ${t.name}`),
      ...usage.assets.map((a) => `asset ${a.name}`),
    ];
    return [
      f.name,
      f.mimeType,
      formatSize(f.size),
      f.scope,
      dash(f.description),
      used.length ? (used.length > 8 ? `${used.slice(0, 8).join(", ")} and ${used.length - 8} more` : used.join(", ")) : "not assigned",
      `${f.sha256.slice(0, 12)}…`,
    ];
  });
  return { headers: ["Name", "Content type", "Size", "Scope", "Description", "Assigned to", "SHA-256"], rows };
}

export const MAX_CHANGELOG_ENTRIES = 500;

/** Newest first. Author user ids are not documented. */
export function changelogEntries(ctx: DocContext): { entries: ChangeLogEntry[]; omitted: number } {
  const all = [...ctx.project.changelog].reverse();
  return { entries: all.slice(0, MAX_CHANGELOG_ENTRIES), omitted: Math.max(0, all.length - MAX_CHANGELOG_ENTRIES) };
}

export function changelogTable(entries: ChangeLogEntry[]): DocTable {
  return { headers: ["Time", "Change"], rows: entries.map((e) => [formatDateTime(e.at), e.summary]) };
}

export interface GuardrailDoc {
  profile: string;
  recommended: DocTable;
  technical: DocTable;
  notes: string[];
}

export function guardrailDoc(ctx: DocContext): GuardrailDoc {
  const g = ctx.guardrails;
  const techSeverity = g.profile === "technical" ? "error (blocks deployment)" : "information";
  return {
    profile:
      g.profile === "technical"
        ? "Technical — recommendations are warnings, Capability Package / P&P technical limits are errors that block deployment."
        : "Recommended — recommendations are warnings, technical limits are reported as information.",
    recommended: {
      headers: ["Recommendation", "Maximum", "Severity"],
      rows: [
        ["Asset types per project", formatInt(g.recommended.maxAssetTypes), "warning"],
        ["Variables per aspect type", formatInt(g.recommended.maxVariablesPerAspectType), "warning"],
        ["Aspects per asset type", formatInt(g.recommended.maxAspectsPerAssetType), "warning"],
        ["Variables per asset type (incl. inherited and aspects)", formatInt(g.recommended.maxVariablesPerAssetType), "warning"],
      ],
    },
    technical: {
      headers: ["Technical limit", "Maximum", "Severity"],
      rows: [
        ["Variables per aspect type", formatInt(TECHNICAL_LIMITS.maxVariablesPerAspectType), techSeverity],
        ["Aspects per asset type", formatInt(TECHNICAL_LIMITS.maxAspectsPerAssetType), techSeverity],
        ["Direct variables per asset type", formatInt(TECHNICAL_LIMITS.maxDirectVariablesPerAssetType), techSeverity],
        ["Asset type inheritance depth", formatInt(TECHNICAL_LIMITS.maxAssetTypeDepth), techSeverity],
        ["Asset hierarchy depth", formatInt(TECHNICAL_LIMITS.maxAssetHierarchyDepth), techSeverity],
        ["Asset attributes per asset", formatInt(TECHNICAL_LIMITS.maxAttributesPerAsset), techSeverity],
        ["Asset attributes per tenant", formatInt(TECHNICAL_LIMITS.maxAttributesPerTenant), techSeverity],
      ],
    },
    notes: [GUARDRAIL_NOTES.assetTypeDepth, GUARDRAIL_NOTES.assetHierarchyDepth, GUARDRAIL_NOTES.attributes],
  };
}
