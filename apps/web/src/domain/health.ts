// Model Health: design smells with concrete split / flatten / merge advice.
//
// Grounded in the platform's modelling guidance
// (docs/reference/overview-and-modelling-guidelines.txt): optimise the asset
// type hierarchy depth, create purpose-specific types, prefer
// core.basicasset as the no-cost parent, remove unwanted variables, and keep
// within the recommended and technical limits.

import { BASIC_ASSET_TYPE_ID } from "./coreLibrary";
import { estimateProject } from "./estimator";
import { ROOT_ASSET_UID, type AspectTypeDef, type AssetTypeDef } from "./model";
import type { ModelIndex } from "./resolve";
import { TECHNICAL_LIMITS, type GuardrailSettings } from "./rules";

export type HealthSeverity = "high" | "medium" | "low";
export type HealthCategory = "split" | "flatten" | "merge" | "cleanup" | "billing" | "reuse";

export interface HealthFinding {
  id: string;
  severity: HealthSeverity;
  category: HealthCategory;
  title: string;
  detail: string;
  suggestion: string;
  target: { kind: "aspectType" | "assetType" | "asset" | "project"; uid: string; label: string };
}

export interface HealthReport {
  /** 0..100, 100 = no findings. */
  score: number;
  findings: HealthFinding[];
  counts: Record<HealthSeverity, number>;
}

const WEIGHT: Record<HealthSeverity, number> = { high: 15, medium: 5, low: 1 };

/** Group variable names by their prefix (before the first "_"), for split proposals. */
export function proposeSplit(names: string[], maxPerGroup: number): string[][] {
  const groups = new Map<string, string[]>();
  for (const n of names) {
    const prefix = n.includes("_") ? n.slice(0, n.indexOf("_")).toLowerCase() : "";
    const list = groups.get(prefix) ?? [];
    list.push(n);
    groups.set(prefix, list);
  }
  const out: string[][] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) out.push(current);
    current = [];
  };
  for (const list of [...groups.values()].sort((a, b) => b.length - a.length)) {
    for (let i = 0; i < list.length; i += maxPerGroup) {
      const chunk = list.slice(i, i + maxPerGroup);
      if (current.length + chunk.length > maxPerGroup) flush();
      current.push(...chunk);
    }
  }
  flush();
  return out;
}

export function analyzeHealth(index: ModelIndex, settings: GuardrailSettings): HealthReport {
  const findings: HealthFinding[] = [];
  const { project } = index;
  const add = (f: HealthFinding) => findings.push(f);
  const atTarget = (t: AspectTypeDef) => ({ kind: "aspectType" as const, uid: t.uid, label: t.name });
  const tTarget = (t: AssetTypeDef) => ({ kind: "assetType" as const, uid: t.uid, label: t.name });

  // Aspect types: too many variables → split; unused → remove.
  for (const t of project.aspectTypes) {
    const n = t.variables.length;
    const rec = settings.recommended.maxVariablesPerAspectType;
    if (n > rec) {
      const groups = proposeSplit(t.variables.map((v) => v.name), rec);
      add({
        id: `split-aspect:${t.uid}`,
        severity: n > TECHNICAL_LIMITS.maxVariablesPerAspectType ? "high" : "medium",
        category: "split",
        title: `Split aspect type “${t.name}”`,
        detail: `${n} variables (recommended ≤ ${rec}, technical limit ${TECHNICAL_LIMITS.maxVariablesPerAspectType}).`,
        suggestion: `Split into ${groups.length} aspect types: ${groups
          .map((g, i) => `#${i + 1} [${g.slice(0, 4).join(", ")}${g.length > 4 ? ", …" : ""}]`)
          .join("; ")}.`,
        target: atTarget(t),
      });
    }
    if (index.aspectTypeUsage(t.uid).length === 0) {
      add({
        id: `unused-aspect:${t.uid}`,
        severity: "low",
        category: "cleanup",
        title: `Unused aspect type “${t.name}”`,
        detail: "No asset type uses this aspect type.",
        suggestion: "Remove it or add it to an asset type.",
        target: atTarget(t),
      });
    }
  }

  // Duplicate direct variables across types → extract a shared aspect type.
  const varUse = new Map<string, AssetTypeDef[]>();
  for (const t of project.assetTypes) {
    for (const v of t.variables) {
      const key = `${v.name.toLowerCase()}|${v.dataType}`;
      const list = varUse.get(key) ?? [];
      list.push(t);
      varUse.set(key, list);
    }
  }
  const sharedByTypes = new Map<string, string[]>();
  for (const [key, types] of varUse) {
    if (types.length < 3) continue;
    const typeKey = types.map((t) => t.uid).sort().join(",");
    const list = sharedByTypes.get(typeKey) ?? [];
    list.push(key.split("|")[0]!);
    sharedByTypes.set(typeKey, list);
  }
  for (const [typeKey, vars] of sharedByTypes) {
    const types = typeKey.split(",").map((uid) => index.assetTypes.get(uid)!);
    add({
      id: `reuse:${typeKey}`,
      severity: "low",
      category: "reuse",
      title: `Variables repeated on ${types.length} asset types`,
      detail: `${vars.join(", ")} are defined directly on ${types.map((t) => t.name).join(", ")}.`,
      suggestion: "Extract them into one static aspect type and add it to these types (or to a common parent).",
      target: tTarget(types[0]!),
    });
  }

  const estimate = estimateProject(index);
  for (const t of project.assetTypes) {
    const r = index.resolveAssetType({ kind: "project", uid: t.uid });
    if (!r) continue;
    if (r.depth > 3) {
      add({
        id: `flatten:${t.uid}`,
        severity: r.depth > TECHNICAL_LIMITS.maxAssetTypeDepth ? "high" : "medium",
        category: "flatten",
        title: `Deep inheritance for “${t.name}”`,
        detail: `Inheritance depth ${r.depth} (technical limit ${TECHNICAL_LIMITS.maxAssetTypeDepth}). Every level propagates its variables to all descendants.`,
        suggestion: "Flatten: inherit from core.basicasset and compose behaviour from aspects instead of intermediate types.",
        target: tTarget(t),
      });
    }
    if (t.variables.length > 10) {
      add({
        id: `direct-vars:${t.uid}`,
        severity: t.variables.length > TECHNICAL_LIMITS.maxDirectVariablesPerAssetType ? "high" : "low",
        category: "split",
        title: `Many direct variables on “${t.name}”`,
        detail: `${t.variables.length} static variables are defined directly (technical limit ${TECHNICAL_LIMITS.maxDirectVariablesPerAssetType}).`,
        suggestion: "Move related direct variables into a reusable static aspect type.",
        target: tTarget(t),
      });
    }
    if (r.aspects.length > settings.recommended.maxAspectsPerAssetType) {
      add({
        id: `merge-aspects:${t.uid}`,
        severity: r.aspects.length > TECHNICAL_LIMITS.maxAspectsPerAssetType ? "high" : "medium",
        category: "merge",
        title: `Too many aspects on “${t.name}”`,
        detail: `${r.aspects.length} aspects (recommended ≤ ${settings.recommended.maxAspectsPerAssetType}).`,
        suggestion: "Merge small aspects of the same category; keep at most 20 variables per aspect.",
        target: tTarget(t),
      });
    }
    if (r.totalVariableCount > settings.recommended.maxVariablesPerAssetType) {
      add({
        id: `purpose:${t.uid}`,
        severity: "medium",
        category: "split",
        title: `“${t.name}” is a catch-all type`,
        detail: `${r.totalVariableCount} variables including inherited ones (recommended ≤ ${settings.recommended.maxVariablesPerAssetType}).`,
        suggestion: "Create purpose-specific asset types so instances do not carry unused variables.",
        target: tTarget(t),
      });
    }
    if (t.parent.kind === "core" && t.parent.id.toLowerCase() !== BASIC_ASSET_TYPE_ID) {
      const parent = index.resolveAssetType(t.parent);
      const inherited = parent ? parent.totalVariableCount : 0;
      if (inherited > 0) {
        add({
          id: `core-parent:${t.uid}`,
          severity: "low",
          category: "billing",
          title: `“${t.name}” inherits from ${t.parent.id}`,
          detail: `The parent adds ${inherited} variables and ${parent?.aspects.length ?? 0} aspects to every instance.`,
          suggestion: "If these are not needed, inherit from core.basicasset (the recommended parent without billable attributes).",
          target: tTarget(t),
        });
      }
    }
    const used = index.assetsOfType({ kind: "project", uid: t.uid }, false).length > 0;
    if (!used && index.childTypesOf(t.uid).length === 0) {
      add({
        id: `unused-type:${t.uid}`,
        severity: "low",
        category: "cleanup",
        title: `Unused asset type “${t.name}”`,
        detail: "No assets and no child types use it.",
        suggestion: "Remove it if it is not planned.",
        target: tTarget(t),
      });
    }
  }

  // Billing hot spot.
  const top = estimate.types[0];
  if (top && estimate.totalAttributes > 0 && top.totalAttributes / estimate.totalAttributes > 0.5 && estimate.types.length > 1) {
    add({
      id: `hotspot:${top.key}`,
      severity: "low",
      category: "billing",
      title: `“${top.name}” drives ${Math.round((top.totalAttributes / estimate.totalAttributes) * 100)}% of attributes`,
      detail: `${top.instances} assets × ${top.perAsset} attributes = ${top.totalAttributes}.`,
      suggestion: "Review whether every variable is needed on every instance; remove unused ones from the type.",
      target: { kind: "project", uid: project.id, label: project.name },
    });
  }

  // Hierarchy depth.
  let deepest = 0;
  let deepestUid = "";
  for (const a of project.assets) {
    if (a.uid === ROOT_ASSET_UID) continue;
    const level = index.levelOf(a.uid);
    if (Number.isFinite(level) && level > deepest) {
      deepest = level;
      deepestUid = a.uid;
    }
  }
  if (deepest > 15) {
    const a = index.assets.get(deepestUid)!;
    add({
      id: `deep-hierarchy:${deepestUid}`,
      severity: deepest > TECHNICAL_LIMITS.maxAssetHierarchyDepth ? "high" : "medium",
      category: "flatten",
      title: "Deep asset hierarchy",
      detail: `“${a.name}” sits at level ${deepest} (technical limit ${TECHNICAL_LIMITS.maxAssetHierarchyDepth}).`,
      suggestion: "Flatten the hierarchy; express grouping with variables or names instead of extra levels.",
      target: { kind: "asset", uid: a.uid, label: a.name },
    });
  }

  const counts: Record<HealthSeverity, number> = { high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity] += 1;
  const order: Record<HealthSeverity, number> = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  const penalty = findings.reduce((n, f) => n + WEIGHT[f.severity], 0);
  return { score: Math.max(0, 100 - penalty), findings, counts };
}
