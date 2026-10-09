// ModelIndex: fast lookups and type resolution over a Project + core library.
//
// Build one index per project revision (it is immutable) and share it between
// the validator, estimator, health panel and editors. All lookups are O(1) or
// memoised, so a 10,000+ asset project indexes in a few milliseconds.

import {
  BASIC_ASSET_TYPE_ID,
  indexCoreLibrary,
  type CoreLibrary,
  type CoreLibraryIndex,
} from "./coreLibrary";
import type { ExternalTypes } from "./external";
import {
  ROOT_ASSET_UID,
  typeRefKey,
  type AspectCategory,
  type AspectTypeDef,
  type AssetDef,
  type AssetTypeDef,
  type DataType,
  type FileDef,
  type Project,
  type TypeRef,
  type VariableDef,
} from "./model";

export interface VariableLike {
  name: string;
  dataType: DataType;
  unit?: string | null;
  searchable: boolean;
  length?: number | null;
  defaultValue?: string | null;
  qualityCode?: boolean;
}

export interface ResolvedVariable extends VariableLike {
  /** uid when the variable is defined in this project. */
  uid?: string;
  /** Asset type that defines the variable (directly or via one of its aspects). */
  definedOn: TypeRef;
  definedOnName: string;
  /** Aspect name when the variable belongs to an aspect. */
  aspectName?: string;
  aspectCategory?: AspectCategory;
  /** True when defined on an ancestor type (not on the type itself). */
  inherited: boolean;
  /** False for variables of core asset types and core aspect types. */
  billable: boolean;
}

export interface ResolvedAspectType {
  ref: TypeRef;
  name: string;
  /** Display id, `{tenant}.<idSuffix>` for project types. */
  displayId: string;
  category: AspectCategory;
  variables: VariableLike[];
  isCore: boolean;
  /** False for external references whose definition is unknown offline. */
  known: boolean;
  def?: AspectTypeDef;
}

export interface ResolvedAspect {
  uid?: string;
  name: string;
  aspectType: ResolvedAspectType;
  definedOn: TypeRef;
  definedOnName: string;
  inherited: boolean;
}

export interface ResolvedAssetType {
  ref: TypeRef;
  name: string;
  displayId: string;
  instantiable: boolean;
  isCore: boolean;
  known: boolean;
  def?: AssetTypeDef;
  parent?: TypeRef;
  /** Self first, then ancestors. */
  chain: TypeRef[];
  /** Inheritance steps below core.basicasset (see GUARDRAIL_NOTES). */
  depth: number;
  cyclic: boolean;
  /** References in the chain that could not be resolved offline. */
  unresolved: TypeRef[];
  /** Static variables, own first then inherited. */
  variables: ResolvedVariable[];
  /** Aspects, own first then inherited. */
  aspects: ResolvedAspect[];
  /** Static variables + variables of all aspects (core included). */
  totalVariableCount: number;
  /** Billable asset attributes contributed by this type (core excluded). */
  billableAttributes: number;
  /** True when part of the definition is unknown (external refs) — counts are lower bounds. */
  incomplete: boolean;
}

export function toVariableLike(v: VariableDef): VariableLike {
  return {
    name: v.name,
    dataType: v.dataType,
    unit: v.unit,
    searchable: v.searchable,
    length: v.length,
    defaultValue: v.defaultValue,
    qualityCode: v.qualityCode,
  };
}

export const TENANT_PLACEHOLDER = "{tenant}";

export class ModelIndex {
  readonly project: Project;
  readonly core: CoreLibraryIndex;
  /** Existing tenant types (tenant catalog) used to resolve `external` refs. */
  readonly external?: ExternalTypes;
  readonly aspectTypes = new Map<string, AspectTypeDef>();
  readonly assetTypes = new Map<string, AssetTypeDef>();
  readonly assets = new Map<string, AssetDef>();
  readonly files = new Map<string, FileDef>();
  private readonly children = new Map<string, AssetDef[]>();
  private readonly childTypes = new Map<string, AssetTypeDef[]>();
  private readonly resolvedAssetTypes = new Map<string, ResolvedAssetType>();
  private readonly levels = new Map<string, number>();

  constructor(project: Project, core: CoreLibrary | CoreLibraryIndex, external?: ExternalTypes) {
    this.project = project;
    this.core = "library" in core && "assetType" in core ? core : indexCoreLibrary(core as CoreLibrary);
    this.external = external;
    for (const t of project.aspectTypes) this.aspectTypes.set(t.uid, t);
    for (const t of project.assetTypes) {
      this.assetTypes.set(t.uid, t);
      if (t.parent.kind === "project") {
        const list = this.childTypes.get(t.parent.uid) ?? [];
        list.push(t);
        this.childTypes.set(t.parent.uid, list);
      }
    }
    for (const f of project.files) this.files.set(f.uid, f);
    for (const a of project.assets) {
      this.assets.set(a.uid, a);
      if (a.parentUid !== null) {
        const list = this.children.get(a.parentUid) ?? [];
        list.push(a);
        this.children.set(a.parentUid, list);
      }
    }
  }

  get root(): AssetDef | undefined {
    return this.assets.get(ROOT_ASSET_UID);
  }

  childrenOf(uid: string): AssetDef[] {
    return this.children.get(uid) ?? [];
  }

  childTypesOf(uid: string): AssetTypeDef[] {
    return this.childTypes.get(uid) ?? [];
  }

  /** All project asset types inheriting (transitively) from the given project type. */
  descendantTypesOf(uid: string): AssetTypeDef[] {
    const out: AssetTypeDef[] = [];
    const seen = new Set<string>([uid]);
    const stack = [...this.childTypesOf(uid)];
    while (stack.length) {
      const t = stack.pop()!;
      if (seen.has(t.uid)) continue;
      seen.add(t.uid);
      out.push(t);
      stack.push(...this.childTypesOf(t.uid));
    }
    return out;
  }

  /** Project ancestors of a project asset type (nearest first), cycle-safe. */
  ancestorTypesOf(uid: string): AssetTypeDef[] {
    const out: AssetTypeDef[] = [];
    const seen = new Set<string>([uid]);
    let cur = this.assetTypes.get(uid);
    while (cur && cur.parent.kind === "project") {
      const parent = this.assetTypes.get(cur.parent.uid);
      if (!parent || seen.has(parent.uid)) break;
      seen.add(parent.uid);
      out.push(parent);
      cur = parent;
    }
    return out;
  }

  /** Ancestors + self + descendants: the scope in which variable/aspect names must be unique. */
  typeFamilyOf(uid: string): AssetTypeDef[] {
    const self = this.assetTypes.get(uid);
    return [...this.ancestorTypesOf(uid), ...(self ? [self] : []), ...this.descendantTypesOf(uid)];
  }

  /** Descendant asset uids (depth-first, excluding the asset itself). */
  descendantsOf(uid: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>([uid]);
    const stack = [...this.childrenOf(uid)].reverse();
    while (stack.length) {
      const a = stack.pop()!;
      if (seen.has(a.uid)) continue;
      seen.add(a.uid);
      out.push(a.uid);
      const kids = this.childrenOf(a.uid);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
    }
    return out;
  }

  /** Root first, asset last. Cycle-safe (stops when a parent repeats). */
  hierarchyPath(uid: string): AssetDef[] {
    const path: AssetDef[] = [];
    const seen = new Set<string>();
    let cur = this.assets.get(uid);
    while (cur && !seen.has(cur.uid)) {
      path.push(cur);
      seen.add(cur.uid);
      cur = cur.parentUid === null ? undefined : this.assets.get(cur.parentUid);
    }
    return path.reverse();
  }

  /** Hierarchy level including the root (root = 1). Returns Infinity for cyclic chains. */
  levelOf(uid: string): number {
    const cached = this.levels.get(uid);
    if (cached !== undefined) return cached;
    const path = this.hierarchyPath(uid);
    const first = path[0];
    const level = first && first.parentUid === null ? path.length : Number.POSITIVE_INFINITY;
    this.levels.set(uid, level);
    return level;
  }

  /** True if the asset's parent chain reaches the root without a cycle. */
  isAttached(uid: string): boolean {
    return Number.isFinite(this.levelOf(uid));
  }

  // -------------------------------------------------------------------------
  // Type resolution
  // -------------------------------------------------------------------------

  aspectTypeDisplayId(def: AspectTypeDef, tenant = TENANT_PLACEHOLDER): string {
    return `${tenant}.${def.idSuffix}`;
  }

  resolveAspectType(ref: TypeRef): ResolvedAspectType | undefined {
    if (ref.kind === "project") {
      const def = this.aspectTypes.get(ref.uid);
      if (!def) return undefined;
      return {
        ref,
        name: def.name,
        displayId: this.aspectTypeDisplayId(def),
        category: def.category,
        variables: def.variables.map(toVariableLike),
        isCore: false,
        known: true,
        def,
      };
    }
    if (ref.kind === "core") {
      const core = this.core.aspectType(ref.id);
      if (!core) return undefined;
      return {
        ref,
        name: core.name,
        displayId: core.id,
        category: core.category,
        variables: core.variables,
        isCore: true,
        known: true,
      };
    }
    const existing = this.external?.aspectType(ref.id);
    if (existing) {
      return {
        ref,
        name: existing.name,
        displayId: existing.id,
        category: existing.category,
        variables: existing.variables,
        isCore: false,
        known: true,
      };
    }
    return {
      ref,
      name: ref.id,
      displayId: ref.id,
      category: "dynamic",
      variables: [],
      isCore: false,
      known: false,
    };
  }

  assetTypeName(ref: TypeRef): string {
    if (ref.kind === "project") return this.assetTypes.get(ref.uid)?.name ?? "(missing type)";
    if (ref.kind === "core") return this.core.assetType(ref.id)?.name ?? ref.id;
    return this.external?.assetType(ref.id)?.name ?? ref.id;
  }

  assetTypeDisplayId(ref: TypeRef, tenant = TENANT_PLACEHOLDER): string {
    if (ref.kind === "project") {
      const def = this.assetTypes.get(ref.uid);
      return def ? `${tenant}.${def.idSuffix}` : "(missing type)";
    }
    return ref.id;
  }

  resolveAssetType(ref: TypeRef): ResolvedAssetType | undefined {
    const key = typeRefKey(ref);
    const cached = this.resolvedAssetTypes.get(key);
    if (cached) return cached;
    const resolved = this.computeAssetType(ref);
    if (resolved) this.resolvedAssetTypes.set(key, resolved);
    return resolved;
  }

  private computeAssetType(ref: TypeRef): ResolvedAssetType | undefined {
    const head = this.describeAssetType(ref);
    if (!head) return undefined;

    const chain: TypeRef[] = [];
    const unresolved: TypeRef[] = [];
    const seen = new Set<string>();
    let cyclic = false;
    let reachedBasicAsset = false;
    const variables: ResolvedVariable[] = [];
    const aspects: ResolvedAspect[] = [];
    let incomplete = false;

    let cur: TypeRef | undefined = ref;
    while (cur) {
      const key = typeRefKey(cur);
      if (seen.has(key)) {
        cyclic = true;
        break;
      }
      seen.add(key);
      const d = this.describeAssetType(cur);
      if (!d) {
        unresolved.push(cur);
        incomplete = true;
        break;
      }
      chain.push(cur);
      if (!d.known) {
        unresolved.push(cur);
        incomplete = true;
      }
      if (cur.kind === "core" && cur.id.toLowerCase() === BASIC_ASSET_TYPE_ID) reachedBasicAsset = true;
      const inherited = chain.length > 1;
      for (const v of d.variables) {
        variables.push({
          ...v.variable,
          uid: v.uid,
          definedOn: cur,
          definedOnName: d.name,
          inherited,
          billable: !d.isCore,
        });
      }
      for (const a of d.aspects) {
        const at = this.resolveAspectType(a.aspectType);
        const aspectType: ResolvedAspectType = at ?? {
          ref: a.aspectType,
          name: "(missing aspect type)",
          displayId: typeRefKey(a.aspectType),
          category: "dynamic",
          variables: [],
          isCore: false,
          known: false,
        };
        if (!aspectType.known) incomplete = true;
        aspects.push({ uid: a.uid, name: a.name, aspectType, definedOn: cur, definedOnName: d.name, inherited });
      }
      cur = d.parent;
    }

    const aspectVariables = aspects.reduce((n, a) => n + a.aspectType.variables.length, 0);
    const billableStatic = variables.filter((v) => v.billable).length;
    // Variables of core aspect types are excluded from billing, and aspects
    // inherited from core asset types never count.
    const billableAspectVars = aspects
      .filter((a) => !a.aspectType.isCore && !(a.definedOn.kind === "core"))
      .reduce((n, a) => n + a.aspectType.variables.length, 0);

    // Depth: inheritance steps below core.basicasset. When the chain does not
    // reach core.basicasset (external/unknown ancestor) count the known steps.
    const depth = Math.max(0, reachedBasicAsset ? chain.length - 1 : chain.length);

    return {
      ...head,
      ref,
      chain,
      depth,
      cyclic,
      unresolved,
      variables,
      aspects,
      totalVariableCount: variables.length + aspectVariables,
      billableAttributes: billableStatic + billableAspectVars,
      incomplete,
    };
  }

  /** One level of an asset type, without inheritance. */
  private describeAssetType(ref: TypeRef):
    | {
        name: string;
        displayId: string;
        instantiable: boolean;
        isCore: boolean;
        known: boolean;
        def?: AssetTypeDef;
        parent?: TypeRef;
        variables: { uid?: string; variable: VariableLike }[];
        aspects: { uid?: string; name: string; aspectType: TypeRef }[];
      }
    | undefined {
    if (ref.kind === "project") {
      const def = this.assetTypes.get(ref.uid);
      if (!def) return undefined;
      return {
        name: def.name,
        displayId: this.assetTypeDisplayId(ref),
        instantiable: def.instantiable,
        isCore: false,
        known: true,
        def,
        parent: def.parent,
        variables: def.variables.map((v) => ({ uid: v.uid, variable: toVariableLike(v) })),
        aspects: def.aspects.map((a) => ({ uid: a.uid, name: a.name, aspectType: a.aspectType })),
      };
    }
    if (ref.kind === "core") {
      const core = this.core.assetType(ref.id);
      if (!core) return undefined;
      return {
        name: core.name,
        displayId: core.id,
        instantiable: core.instantiable,
        isCore: true,
        known: true,
        parent: core.parentTypeId ? { kind: "core", id: core.parentTypeId } : undefined,
        variables: core.variables.map((variable) => ({ variable })),
        aspects: core.aspects.map((a) => ({
          name: a.name,
          aspectType: { kind: "core", id: a.aspectTypeId },
        })),
      };
    }
    const existing = this.external?.assetType(ref.id);
    if (existing) {
      const refOf = (id: string): TypeRef =>
        id.toLowerCase().startsWith("core.") ? { kind: "core", id } : { kind: "external", id };
      return {
        name: existing.name,
        displayId: existing.id,
        instantiable: existing.instantiable,
        isCore: false,
        known: true,
        parent: existing.parentTypeId ? refOf(existing.parentTypeId) : undefined,
        variables: existing.variables.map((variable) => ({ variable })),
        aspects: existing.aspects.map((a) => ({ name: a.name, aspectType: refOf(a.aspectTypeId) })),
      };
    }
    return {
      name: ref.id,
      displayId: ref.id,
      instantiable: true,
      isCore: false,
      known: false,
      variables: [],
      aspects: [],
    };
  }

  // -------------------------------------------------------------------------
  // Existing tenant types (linked catalog)
  // -------------------------------------------------------------------------

  /**
   * True when a project type already stands for the existing tenant type
   * `<tenant>.<idSuffix>` (deploying the project type updates it), so the
   * existing one must not be offered a second time.
   */
  private shadowed(id: string, projectSuffixes: Set<string>): boolean {
    const ext = this.external;
    if (!ext) return false;
    const prefix = `${ext.tenant.toLowerCase()}.`;
    const lower = id.toLowerCase();
    return lower.startsWith(prefix) && projectSuffixes.has(lower.slice(prefix.length));
  }

  /** Existing tenant asset types that are not represented by a project type. */
  externalAssetTypes() {
    const suffixes = new Set(this.project.assetTypes.map((t) => t.idSuffix.toLowerCase()));
    return (this.external?.assetTypes ?? []).filter((t) => !this.shadowed(t.id, suffixes));
  }

  /** Existing tenant aspect types that are not represented by a project type. */
  externalAspectTypes() {
    const suffixes = new Set(this.project.aspectTypes.map((t) => t.idSuffix.toLowerCase()));
    return (this.external?.aspectTypes ?? []).filter((t) => !this.shadowed(t.id, suffixes));
  }

  // -------------------------------------------------------------------------
  // Usage lookups (impact analysis)
  // -------------------------------------------------------------------------

  /** Asset types (project) that reference the aspect type in their own aspects. */
  aspectTypeUsage(aspectTypeUid: string): { assetType: AssetTypeDef; aspectName: string }[] {
    const out: { assetType: AssetTypeDef; aspectName: string }[] = [];
    for (const t of this.project.assetTypes) {
      for (const a of t.aspects) {
        if (a.aspectType.kind === "project" && a.aspectType.uid === aspectTypeUid) {
          out.push({ assetType: t, aspectName: a.name });
        }
      }
    }
    return out;
  }

  /** Assets whose type is exactly the given type, or (optionally) a descendant of it. */
  assetsOfType(ref: TypeRef, includeDescendantTypes = true): AssetDef[] {
    const keys = new Set<string>([typeRefKey(ref)]);
    if (includeDescendantTypes && ref.kind === "project") {
      for (const t of this.descendantTypesOf(ref.uid)) keys.add(`project:${t.uid}`);
    }
    if (includeDescendantTypes && ref.kind !== "project") {
      for (const t of this.project.assetTypes) {
        const r = this.resolveAssetType({ kind: "project", uid: t.uid });
        if (r?.chain.some((c) => typeRefKey(c) === typeRefKey(ref))) keys.add(`project:${t.uid}`);
      }
    }
    return this.project.assets.filter((a) => a.uid !== ROOT_ASSET_UID && keys.has(typeRefKey(a.type)));
  }

  /** Assets and asset types that reference a file. */
  fileUsage(fileUid: string): { assets: AssetDef[]; assetTypes: AssetTypeDef[] } {
    return {
      assets: this.project.assets.filter((a) => a.fileAssignments.some((f) => f.fileUid === fileUid)),
      assetTypes: this.project.assetTypes.filter((t) =>
        t.fileAssignments.some((f) => f.fileUid === fileUid),
      ),
    };
  }
}
