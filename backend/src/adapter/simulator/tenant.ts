// adapter/simulator/tenant holds one simulated tenant in memory: the seeded
// read-only core types, the tenant's own aspect types, asset types, assets
// and file metadata, plus the model lock. It offers the lookups and the
// resource rendering shared by all simulator handlers.
//
// Ids of types are case-insensitive (docs: types "with same names but
// different cases ... are treated same"), so maps are keyed by lower-case id.

import { createHash } from 'node:crypto';

import {
  CORE_ASPECT_TYPES,
  CORE_ASSET_TYPES,
  ROOT_ASSET_TYPE_ID,
  ROOT_HIERARCHY_TYPE_ID,
} from './core-library.js';
import type {
  AspectTypeRec,
  AspectValuesRec,
  AssetRec,
  AssetTypeRec,
  FileAssignmentRec,
  FileRec,
  LocationRec,
  SimStateFile,
  TypeAspectRec,
  ValueRec,
  VariableDef,
} from './model.js';

/** Base URL used in HAL links (".invalid" never resolves). */
export const SIM_BASE = 'https://am-simulator.invalid/api/assetmanagement/v3';
export const DEFAULT_TIMEZONE = 'Europe/Berlin';
const CORE_TENANT = 'core';
const CORE_ETAG = 1;

const lc = (s: string): string => s.toLowerCase();

export const isCoreId = (id: string): boolean => lc(id).startsWith('core.');

function coreAspectId(typeId: string, aspectName: string): string {
  return createHash('md5').update(`${typeId}/${aspectName}`).digest('hex');
}

function coreAspectTypes(): AspectTypeRec[] {
  return CORE_ASPECT_TYPES.map((t) => ({
    id: t.id,
    tenantId: CORE_TENANT,
    name: t.name,
    category: t.category,
    scope: 'public',
    description: t.description,
    variables: t.variables.map((v) => ({
      ...v,
      qualityCode: v.qualityCode ?? false,
    })),
    etag: CORE_ETAG,
  }));
}

function coreAssetTypes(): AssetTypeRec[] {
  return CORE_ASSET_TYPES.map((t) => ({
    id: t.id,
    tenantId: CORE_TENANT,
    name: t.name,
    description: t.description,
    parentTypeId: t.parentTypeId,
    instantiable: t.instantiable,
    scope: 'public',
    variables: t.variables.map((v) => {
      const { qualityCode: _q, ...rest } = v;
      return rest;
    }),
    aspects: t.aspects.map((a) => ({
      name: a.name,
      aspectTypeId: a.aspectTypeId,
      aspectId: coreAspectId(t.id, a.name),
    })),
    fileAssignments: [],
    etag: CORE_ETAG,
  }));
}

export interface Inherited<T> {
  item: T;
  /** Id of the type that defines the item. */
  origin: string;
}

export class SimTenant {
  /** Tenant name used for new type ids; follows the connection settings. */
  tenant: string;
  rootAssetId: string;
  modelLock: boolean;
  readonly aspectTypes = new Map<string, AspectTypeRec>();
  readonly assetTypes = new Map<string, AssetTypeRec>();
  readonly assets = new Map<string, AssetRec>();
  readonly files = new Map<string, FileRec>();

  constructor(state: SimStateFile) {
    this.tenant = state.tenant;
    this.rootAssetId = state.rootAssetId;
    this.modelLock = state.modelLock;
    for (const t of coreAspectTypes()) this.aspectTypes.set(lc(t.id), t);
    for (const t of coreAssetTypes()) this.assetTypes.set(lc(t.id), t);
    for (const t of state.aspectTypes) this.aspectTypes.set(lc(t.id), t);
    for (const t of state.assetTypes) this.assetTypes.set(lc(t.id), t);
    for (const a of state.assets) this.assets.set(lc(a.assetId), a);
    for (const f of state.files) this.files.set(lc(f.id), f);
  }

  /** A fresh tenant: only the root asset of type core.basicenterprise. */
  static seed(tenant: string, rootAssetId: string): SimStateFile {
    const root: AssetRec = {
      assetId: rootAssetId,
      tenantId: tenant,
      name: tenant,
      externalId: null,
      description: null,
      typeId: ROOT_ASSET_TYPE_ID,
      parentId: null,
      timezone: DEFAULT_TIMEZONE,
      twinType: 'performance',
      location: null,
      variables: [],
      aspects: [],
      fileAssignments: [],
      etag: 0,
    };
    return {
      version: 1,
      tenant,
      rootAssetId,
      modelLock: false,
      aspectTypes: [],
      assetTypes: [],
      assets: [root],
      files: [],
    };
  }

  toState(): SimStateFile {
    return {
      version: 1,
      tenant: this.tenant,
      rootAssetId: this.rootAssetId,
      modelLock: this.modelLock,
      aspectTypes: [...this.aspectTypes.values()].filter(
        (t) => !isCoreId(t.id),
      ),
      assetTypes: [...this.assetTypes.values()].filter((t) => !isCoreId(t.id)),
      assets: [...this.assets.values()],
      files: [...this.files.values()],
    };
  }

  // --- lookups ----------------------------------------------------------------

  aspectType(id: string): AspectTypeRec | undefined {
    return this.aspectTypes.get(lc(id));
  }

  assetType(id: string): AssetTypeRec | undefined {
    return this.assetTypes.get(lc(id));
  }

  asset(id: string): AssetRec | undefined {
    return this.assets.get(lc(id));
  }

  file(id: string): FileRec | undefined {
    return this.files.get(lc(id));
  }

  /** The type followed by its ancestors (self first). Cycle-safe. */
  typeChain(typeId: string): AssetTypeRec[] {
    const out: AssetTypeRec[] = [];
    const seen = new Set<string>();
    let cur = this.assetType(typeId);
    while (cur && !seen.has(lc(cur.id))) {
      out.push(cur);
      seen.add(lc(cur.id));
      cur = cur.parentTypeId ? this.assetType(cur.parentTypeId) : undefined;
    }
    return out;
  }

  descendsFrom(typeId: string, ancestorId: string): boolean {
    return this.typeChain(typeId).some((t) => lc(t.id) === lc(ancestorId));
  }

  childTypes(typeId: string): AssetTypeRec[] {
    return [...this.assetTypes.values()].filter(
      (t) => t.parentTypeId !== null && lc(t.parentTypeId) === lc(typeId),
    );
  }

  descendantTypes(typeId: string): AssetTypeRec[] {
    return [...this.assetTypes.values()].filter(
      (t) => lc(t.id) !== lc(typeId) && this.descendsFrom(t.id, typeId),
    );
  }

  /** Assets whose type is `typeId` or derived from it. */
  instancesOf(typeId: string, includeDescendants = true): AssetRec[] {
    return [...this.assets.values()].filter((a) =>
      includeDescendants
        ? this.descendsFrom(a.typeId, typeId)
        : lc(a.typeId) === lc(typeId),
    );
  }

  /** Variables including inherited ones, root ancestor first. */
  explodedVariables(typeId: string): Inherited<VariableDef>[] {
    return this.typeChain(typeId)
      .reverse()
      .flatMap((t) => t.variables.map((item) => ({ item, origin: t.id })));
  }

  /** Aspects including inherited ones, root ancestor first. */
  explodedAspects(typeId: string): Inherited<TypeAspectRec>[] {
    return this.typeChain(typeId)
      .reverse()
      .flatMap((t) => t.aspects.map((item) => ({ item, origin: t.id })));
  }

  /** File assignments of a type incl. inherited ones (own keys win). */
  typeFileAssignments(typeId: string): Inherited<FileAssignmentRec>[] {
    const byKey = new Map<string, Inherited<FileAssignmentRec>>();
    for (const t of this.typeChain(typeId).reverse()) {
      for (const fa of t.fileAssignments)
        byKey.set(lc(fa.key), { item: fa, origin: t.id });
    }
    return [...byKey.values()];
  }

  assetChildren(assetId: string): AssetRec[] {
    return [...this.assets.values()].filter(
      (a) => a.parentId !== null && lc(a.parentId) === lc(assetId),
    );
  }

  /** Ancestors from the root down to the direct parent. */
  assetAncestors(asset: AssetRec): AssetRec[] {
    const out: AssetRec[] = [];
    const seen = new Set<string>([lc(asset.assetId)]);
    let cur = asset.parentId ? this.asset(asset.parentId) : undefined;
    while (cur && !seen.has(lc(cur.assetId))) {
      out.unshift(cur);
      seen.add(lc(cur.assetId));
      cur = cur.parentId ? this.asset(cur.parentId) : undefined;
    }
    return out;
  }

  isAncestorOrSelf(candidateId: string, asset: AssetRec): boolean {
    if (lc(candidateId) === lc(asset.assetId)) return true;
    return this.assetAncestors(asset).some(
      (a) => lc(a.assetId) === lc(candidateId),
    );
  }

  effectiveLocation(asset: AssetRec): LocationRec | null {
    if (asset.location) return asset.location;
    const ancestors = this.assetAncestors(asset);
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const loc = ancestors[i]!.location;
      if (loc) return loc;
    }
    return null;
  }

  isFileAssigned(fileId: string): boolean {
    const id = lc(fileId);
    for (const t of this.assetTypes.values()) {
      if (t.fileAssignments.some((fa) => lc(fa.fileId) === id)) return true;
    }
    for (const a of this.assets.values()) {
      if (a.fileAssignments.some((fa) => lc(fa.fileId) === id)) return true;
    }
    return false;
  }

  /** The aspect type behind an asset's aspect name (via its type). */
  assetAspectType(
    asset: AssetRec,
    aspectName: string,
  ): AspectTypeRec | undefined {
    const hit = this.explodedAspects(asset.typeId).find(
      (a) => lc(a.item.name) === lc(aspectName),
    );
    return hit ? this.aspectType(hit.item.aspectTypeId) : undefined;
  }

  isRootHierarchyType(typeId: string): boolean {
    return this.descendsFrom(typeId, ROOT_HIERARCHY_TYPE_ID);
  }

  // --- rendering ----------------------------------------------------------------

  link(path: string): { href: string } {
    return { href: `${SIM_BASE}${path}` };
  }

  renderVariable(
    v: VariableDef,
    kind: 'aspect' | 'asset',
    origin?: string,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {
      name: v.name,
      unit: v.unit,
      searchable: v.searchable,
      defaultValue: v.defaultValue,
      dataType: v.dataType,
      length: v.length,
    };
    if (kind === 'aspect') out.qualityCode = v.qualityCode ?? false;
    if (origin !== undefined)
      out._links = { origin: this.link(`/assettypes/${origin}`) };
    return out;
  }

  renderAspectType(t: AspectTypeRec): Record<string, unknown> {
    return {
      id: t.id,
      tenantId: t.tenantId,
      name: t.name,
      category: t.category,
      scope: t.scope,
      ...(t.description !== undefined ? { description: t.description } : {}),
      variables: t.variables.map((v) => this.renderVariable(v, 'aspect')),
      etag: t.etag,
      sharing: { modes: [] },
      _links: { self: this.link(`/aspecttypes/${t.id}`) },
    };
  }

  private renderFileAssignment(
    fa: FileAssignmentRec,
    originPath?: string,
  ): Record<string, unknown> {
    return {
      key: fa.key,
      fileId: fa.fileId,
      _links: {
        download: this.link(`/files/${fa.fileId}/file`),
        metadata: this.link(`/files/${fa.fileId}`),
        ...(originPath !== undefined ? { origin: this.link(originPath) } : {}),
      },
    };
  }

  renderAssetType(t: AssetTypeRec, exploded: boolean): Record<string, unknown> {
    const self = lc(t.id);
    const vars = exploded
      ? this.explodedVariables(t.id)
      : t.variables.map((item) => ({ item, origin: t.id }));
    const aspects = exploded
      ? this.explodedAspects(t.id)
      : t.aspects.map((item) => ({ item, origin: t.id }));
    return {
      id: t.id,
      tenantId: t.tenantId,
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      parentTypeId: t.parentTypeId,
      instantiable: t.instantiable,
      scope: t.scope,
      variables: vars.map(({ item, origin }) =>
        this.renderVariable(
          item,
          'asset',
          lc(origin) === self ? undefined : origin,
        ),
      ),
      aspects: aspects.map(({ item, origin }) => {
        const at = this.aspectType(item.aspectTypeId);
        return {
          name: item.name,
          aspectId: item.aspectId,
          ...(at ? { aspectType: this.renderAspectType(at) } : {}),
          ...(lc(origin) !== self
            ? { _links: { origin: this.link(`/assettypes/${origin}`) } }
            : {}),
        };
      }),
      fileAssignments: this.typeFileAssignments(t.id).map(({ item, origin }) =>
        this.renderFileAssignment(
          item,
          lc(origin) === self ? undefined : `/assettypes/${origin}`,
        ),
      ),
      etag: t.etag,
      sharing: { modes: [] },
      _links: {
        self: this.link(`/assettypes/${t.id}`),
        ...(t.parentTypeId
          ? { parent: this.link(`/assettypes/${t.parentTypeId}`) }
          : {}),
      },
    };
  }

  /** Values of an asset: explicit values over type default values. */
  effectiveVariables(a: AssetRec): ValueRec[] {
    const explicit = new Map(a.variables.map((v) => [lc(v.name), v.value]));
    const out: ValueRec[] = [];
    for (const { item } of this.explodedVariables(a.typeId)) {
      const value = explicit.get(lc(item.name)) ?? item.defaultValue;
      if (value !== null && value !== undefined)
        out.push({ name: item.name, value });
    }
    return out;
  }

  /** Static aspects that carry at least one (explicit or default) value. */
  effectiveAspects(a: AssetRec): AspectValuesRec[] {
    const explicit = new Map(
      a.aspects.map((asp) => [
        lc(asp.name),
        new Map(asp.variables.map((v) => [lc(v.name), v.value])),
      ]),
    );
    const out: AspectValuesRec[] = [];
    for (const { item } of this.explodedAspects(a.typeId)) {
      const at = this.aspectType(item.aspectTypeId);
      if (!at || at.category !== 'static') continue;
      const values = explicit.get(lc(item.name));
      const variables: ValueRec[] = [];
      for (const v of at.variables) {
        const value = values?.get(lc(v.name)) ?? v.defaultValue;
        if (value !== null && value !== undefined)
          variables.push({ name: v.name, value });
      }
      if (variables.length > 0) out.push({ name: item.name, variables });
    }
    return out;
  }

  renderAsset(
    a: AssetRec,
    opts: { basicFieldsOnly?: boolean } = {},
  ): Record<string, unknown> {
    const isRoot = lc(a.assetId) === lc(this.rootAssetId);
    const location = this.effectiveLocation(a);
    const own = new Set(a.fileAssignments.map((fa) => lc(fa.key)));
    const fileAssignments = [
      ...a.fileAssignments.map((fa) => this.renderFileAssignment(fa)),
      ...this.typeFileAssignments(a.typeId)
        .filter(({ item }) => !own.has(lc(item.key)))
        .map(({ item, origin }) =>
          this.renderFileAssignment(item, `/assettypes/${origin}`),
        ),
    ];
    const childrenFilter = encodeURIComponent(
      JSON.stringify({ parentId: a.assetId }),
    );
    const out: Record<string, unknown> = {
      assetId: a.assetId,
      tenantId: a.tenantId,
      name: a.name,
      etag: a.etag,
      externalId: a.externalId,
      t2Tenant: null,
      subTenant: null,
      description: a.description,
      timezone: a.timezone,
      ...(a.parentId !== null ? { parentId: a.parentId } : {}),
      typeId: a.typeId,
      twinType: a.twinType,
      ...(location ? { location: { ...location } } : {}),
      fileAssignments,
    };
    if (!opts.basicFieldsOnly) {
      out.variables = this.effectiveVariables(a);
      out.aspects = this.effectiveAspects(a);
    }
    out.locks = [];
    out.deleted = null;
    out.sharing = { modes: [] };
    out.hierarchyPath = isRoot
      ? []
      : this.assetAncestors(a).map((p) => ({
          assetId: p.assetId,
          name: p.name,
        }));
    out._links = {
      self: this.link(`/assets/${a.assetId}`),
      ...(a.parentId !== null
        ? { parent: this.link(`/assets/${a.parentId}`) }
        : {}),
      children: this.link(`/assets?filter=${childrenFilter}`),
      variables: this.link(`/assets/${a.assetId}/variables`),
      aspects: this.link(`/assets/${a.assetId}/aspects`),
      location: this.link(`/assets/${a.assetId}/location`),
    };
    return out;
  }

  renderFile(f: FileRec): Record<string, unknown> {
    return {
      id: f.id,
      name: f.name,
      originalFileName: f.originalFileName,
      ...(f.description !== null ? { description: f.description } : {}),
      tenantId: f.tenantId,
      subTenant: null,
      uploaded: f.uploaded,
      lastModified: f.lastModified,
      isAssigned: this.isFileAssigned(f.id),
      scope: f.scope,
      etag: f.etag,
      _links: {
        self: this.link(`/files/${f.id}`),
        download: this.link(`/files/${f.id}/file`),
      },
    };
  }
}
