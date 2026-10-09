// Converters between the offline project model and Asset Management v3
// resources (docs/reference/assetmanagement-v3.yaml):
//
//   (a) project → request bodies: AspectType (PUT /aspecttypes/{id}),
//       AssetType (PUT /assettypes/{id}), Asset (POST /assets), Location,
//       VariableDefinition and merge-patch helpers;
//   (b) TenantSnapshot → Project for backups and cross-tenant copies, with
//       baselines, origins and the mapping entries that make a redeploy to
//       the source tenant idempotent.

import type {
  AmAspect,
  AmAspectType,
  AmAspectTypeResource,
  AmAsset,
  AmAssetResource,
  AmAssetType,
  AmAssetTypeResource,
  AmFileMetadata,
  AmLocation,
  AmVariable,
  AmVariableDefinition,
} from "@/api/amTypes";
import { base64ToBlob } from "@/api/client";
import { ROOT_ASSET_TYPE_ID } from "@/domain/coreLibrary";
import { formatZodIssues } from "@/domain/migrate";
import { mimeForFileName } from "@/domain/mime";
import {
  PROJECT_SCHEMA_VERSION,
  ProjectSchema,
  ROOT_ASSET_UID,
  composeTypeId,
  createRootAsset,
  newUid,
  splitTypeId,
  type AspectCategory,
  type AspectTypeDef,
  type AssetDef,
  type AssetTypeDef,
  type FileDef,
  type Location,
  type Project,
  type TypeRef,
  type VariableDef,
} from "@/domain/model";
import type { ModelIndex } from "@/domain/resolve";
import { supportsLength } from "@/domain/rules";
import type { MappingEntry, MappingRecord } from "@/storage/db";
import { putFileBlob, sha256Hex } from "@/storage/repository";
import { blankToUndefined, isOwn, normalizeLocation, sameJson } from "@/deploy/comparable";
import { emptyMapping, entityKey, memberKey } from "@/deploy/mapping";
import type { Transport } from "@/deploy/transport";
import { allTypes, type TenantSnapshot } from "./read";

const lc = (s: string) => s.toLowerCase();

// ---------------------------------------------------------------------------
// (a) Project → request bodies
// ---------------------------------------------------------------------------

/** VariableDefinition / AspectVariable for a project variable. */
export function variableBody(
  v: VariableDef,
  owner: "aspectType" | "assetType",
  category?: AspectCategory,
): AmVariableDefinition {
  const out: AmVariableDefinition = { name: v.name, dataType: v.dataType, searchable: v.searchable };
  if (v.unit) out.unit = v.unit;
  if (v.length !== undefined && supportsLength(v.dataType)) out.length = v.length;
  // Default values exist for static variables only (asset types, static aspects).
  if (v.defaultValue !== undefined && !(owner === "aspectType" && category === "dynamic")) {
    out.defaultValue = v.defaultValue;
  }
  if (owner === "aspectType") out.qualityCode = v.qualityCode ?? false;
  return out;
}

/** PUT /aspecttypes/{id} body (`AspectType`). Only private types can be created. */
export function aspectTypeBody(t: AspectTypeDef): AmAspectType {
  const body: AmAspectType = {
    name: t.name,
    category: t.category,
    scope: "private",
    variables: t.variables.map((v) => variableBody(v, "aspectType", t.category)),
  };
  if (t.description) body.description = t.description;
  return body;
}

export interface TypeIdContext {
  tenant: string;
  index: ModelIndex;
}

/** Tenant id for a type reference: `<tenant>.<idSuffix>` for project types. */
export function resolveTypeId(ref: TypeRef, kind: "assetType" | "aspectType", ctx: TypeIdContext): string {
  if (ref.kind !== "project") return ref.id;
  const def = kind === "assetType" ? ctx.index.assetTypes.get(ref.uid) : ctx.index.aspectTypes.get(ref.uid);
  return def ? composeTypeId(ctx.tenant, def.idSuffix) : `${ctx.tenant}.(missing)`;
}

/** PUT /assettypes/{id} body (`AssetType`). File assignments are set in their own phase. */
export function assetTypeBody(t: AssetTypeDef, ctx: TypeIdContext): AmAssetType {
  const body: AmAssetType = {
    name: t.name,
    parentTypeId: resolveTypeId(t.parent, "assetType", ctx),
    instantiable: t.instantiable,
    scope: "private",
    variables: t.variables.map((v) => variableBody(v, "assetType")),
    aspects: t.aspects.map((a) => ({ name: a.name, aspectTypeId: resolveTypeId(a.aspectType, "aspectType", ctx) })),
  };
  if (t.description) body.description = t.description;
  return body;
}

export function locationBody(loc: Location): AmLocation {
  return { ...(normalizeLocation(loc) ?? {}) };
}

/** Values of static aspects only — dynamic aspects carry time series, not values. */
export function staticAspectValues(a: AssetDef, index: ModelIndex): AmAspect[] {
  const resolved = index.resolveAssetType(a.type);
  const categories = new Map((resolved?.aspects ?? []).map((x) => [lc(x.name), x.aspectType.category]));
  return a.aspects
    .filter((av) => av.variables.length > 0 && categories.get(lc(av.name)) !== "dynamic")
    .map((av) => ({ name: av.name, variables: av.variables.map((v) => ({ name: v.name, value: v.value })) }));
}

/** POST /assets body (`Asset`). */
export function assetCreateBody(a: AssetDef, typeId: string, parentId: string, index: ModelIndex): AmAsset {
  const body: AmAsset = { name: a.name, typeId, parentId, twinType: a.twinType };
  if (a.externalId) body.externalId = a.externalId;
  if (a.description) body.description = a.description;
  // Timezone is create-only; omit it so the tenant default applies when unset.
  if (a.timezone) body.timezone = a.timezone;
  const loc = normalizeLocation(a.location);
  if (loc) body.location = loc;
  if (a.variables.length) body.variables = a.variables.map((v) => ({ name: v.name, value: v.value }));
  const aspects = staticAspectValues(a, index);
  if (aspects.length) body.aspects = aspects;
  return body;
}

/**
 * Desired variable values for PATCH /assets/{id}: the project's values plus
 * target values the project does not mention (merge patch replaces arrays, so
 * those are sent back unchanged instead of being reset).
 */
export function mergedValues(project: AmVariable[], target: AmVariable[] | undefined): AmVariable[] {
  const names = new Set(project.map((v) => lc(v.name)));
  return [...project.map((v) => ({ name: v.name, value: v.value })), ...(target ?? []).filter((v) => !names.has(lc(v.name))).map((v) => ({ name: v.name, value: v.value }))];
}

export function mergedAspects(project: AmAspect[], target: AmAspect[] | undefined): AmAspect[] {
  const targetByName = new Map((target ?? []).map((a) => [lc(a.name), a]));
  const names = new Set(project.map((a) => lc(a.name)));
  const out = project.map((a) => ({ name: a.name, variables: mergedValues(a.variables, targetByName.get(lc(a.name))?.variables) }));
  for (const t of target ?? []) {
    if (!names.has(lc(t.name)) && t.variables?.length) out.push({ name: t.name, variables: t.variables.map((v) => ({ name: v.name, value: v.value })) });
  }
  return out;
}

/** RFC 7396: null removes a member; undefined leaves it out of the patch. */
export function patchField(desired: string | undefined, current: string | null | undefined): string | null | undefined {
  const d = blankToUndefined(desired);
  const c = blankToUndefined(current);
  if (d === c) return undefined;
  return d ?? null;
}

// ---------------------------------------------------------------------------
// (b) TenantSnapshot → Project
// ---------------------------------------------------------------------------

export interface BlobStore {
  put(blob: Blob): Promise<string>;
}

/** Persist every blob of a MemoryBlobStore for `project` (putFileBlob) and point the FileDefs at them. */
export async function persistBlobs(project: Project, store: MemoryBlobStore): Promise<void> {
  for (const f of project.files) {
    const blob = f.blobId ? store.get(f.blobId) : undefined;
    if (blob) f.blobId = await putFileBlob(project.id, blob);
  }
}

/** Keeps downloaded contents in memory until the project is saved. */
export class MemoryBlobStore implements BlobStore {
  readonly blobs = new Map<string, Blob>();
  async put(blob: Blob): Promise<string> {
    const id = newUid();
    this.blobs.set(id, blob);
    return id;
  }
  get(id: string): Blob | undefined {
    return this.blobs.get(id);
  }
}

export interface SnapshotToProjectOptions {
  name: string;
  description?: string;
  connectionId: string;
  /** Download file contents (GET /files/{id}/file) into blobs. */
  includeFileContents?: boolean;
  transport?: Transport;
  blobs?: BlobStore;
  hash?: (blob: Blob) => Promise<string>;
  /** Restrict the conversion to these file ids (content download only). */
  onProgress?: (message: string, done: number, total: number) => void;
  now?: () => string;
  projectId?: string;
}

export interface SnapshotConversion {
  project: Project;
  mapping: MappingRecord;
  warnings: string[];
  /** tenant id → project uid, per kind. */
  uids: { aspectTypes: Map<string, string>; assetTypes: Map<string, string>; assets: Map<string, string>; files: Map<string, string> };
}

function variableFromTarget(v: AmVariableDefinition, owner: "aspectType" | "assetType"): VariableDef {
  const out: VariableDef = {
    uid: newUid(),
    name: v.name,
    dataType: v.dataType,
    searchable: !!v.searchable,
  };
  const unit = blankToUndefined(v.unit);
  if (unit !== undefined) out.unit = unit;
  if (supportsLength(v.dataType) && v.length !== null && v.length !== undefined) out.length = v.length;
  const dv = blankToUndefined(v.defaultValue);
  if (dv !== undefined) out.defaultValue = dv;
  if (owner === "aspectType") out.qualityCode = !!v.qualityCode;
  out.baseline = {
    dataType: v.dataType,
    searchable: !!v.searchable,
    ...(out.length !== undefined ? { length: out.length } : {}),
  };
  return out;
}

/** Depth of an asset in the snapshot hierarchy (root children = 1). */
function depthIndex(snapshot: TenantSnapshot): Map<string, number> {
  const byId = new Map(snapshot.assets.map((a) => [a.assetId, a]));
  const depth = new Map<string, number>([[snapshot.root.assetId, 0]]);
  const visit = (a: AmAssetResource, seen: Set<string>): number => {
    const cached = depth.get(a.assetId);
    if (cached !== undefined) return cached;
    if (seen.has(a.assetId) || !a.parentId) return Number.POSITIVE_INFINITY;
    seen.add(a.assetId);
    const parent = a.parentId === snapshot.root.assetId ? undefined : byId.get(a.parentId);
    const d = a.parentId === snapshot.root.assetId ? 1 : parent ? visit(parent, seen) + 1 : Number.POSITIVE_INFINITY;
    depth.set(a.assetId, d);
    return d;
  };
  for (const a of snapshot.assets) visit(a, new Set());
  return depth;
}

/**
 * Convert a tenant snapshot into a project. Tenant-owned types become project
 * definitions with baselines; core / other types stay references; the tenant
 * root becomes the ROOT_ASSET_UID placeholder. Returns the mapping entries for
 * the source connection.
 */
export async function snapshotToProject(
  snapshot: TenantSnapshot,
  opts: SnapshotToProjectOptions,
): Promise<SnapshotConversion> {
  const at = opts.now?.() ?? new Date().toISOString();
  const warnings: string[] = [];
  const projectId = opts.projectId ?? newUid();
  const mapping = emptyMapping(projectId, opts.connectionId, snapshot.tenant, at);
  // Entries come from reading the tenant, not from deploying: sync mode never
  // deletes them physically (see MappingEntry.imported).
  const put = (key: string, entry: Omit<MappingEntry, "deployedAt">) => {
    mapping.entries[key] = { ...entry, imported: true, deployedAt: at };
  };
  const origin = (ref: string) => ({ source: "tenant" as const, ref, at });

  const aspectUid = new Map<string, string>();
  const assetTypeUid = new Map<string, string>();
  const assetUid = new Map<string, string>();
  const fileUid = new Map<string, string>();
  for (const t of snapshot.aspectTypes.tenant) aspectUid.set(lc(t.id), newUid());
  for (const t of snapshot.assetTypes.tenant) assetTypeUid.set(lc(t.id), newUid());
  for (const f of snapshot.files) fileUid.set(f.id, newUid());

  const ref = (id: string, kind: "assetType" | "aspectType"): TypeRef => {
    const uid = (kind === "assetType" ? assetTypeUid : aspectUid).get(lc(id));
    if (uid) return { kind: "project", uid };
    if (lc(id).startsWith("core.")) return { kind: "core", id };
    return { kind: "external", id };
  };

  // Aspect types
  const aspectTypes: AspectTypeDef[] = snapshot.aspectTypes.tenant.map((t: AmAspectTypeResource) => {
    const uid = aspectUid.get(lc(t.id))!;
    const { idSuffix } = splitTypeId(t.id);
    const variables = (t.variables ?? []).map((v) => variableFromTarget(v, "aspectType"));
    put(entityKey("aspectType", uid), { kind: "aspectType", tenantId: t.id, name: t.name, etag: t.etag });
    for (const v of variables) put(memberKey("variable", uid, v.uid), { kind: "variable", tenantId: t.id, name: v.name, ownerUid: uid });
    const def: AspectTypeDef = {
      uid,
      idSuffix,
      name: t.name,
      category: t.category,
      variables,
      origin: origin(t.id),
      baseline: { idSuffix, name: t.name, category: t.category },
    };
    const description = blankToUndefined(t.description);
    if (description !== undefined) def.description = description;
    return def;
  });

  // Asset types
  const assetTypes: AssetTypeDef[] = snapshot.assetTypes.tenant.map((t: AmAssetTypeResource) => {
    const uid = assetTypeUid.get(lc(t.id))!;
    const { idSuffix } = splitTypeId(t.id);
    const variables = (t.variables ?? []).filter(isOwn).map((v) => variableFromTarget(v, "assetType"));
    const aspects = (t.aspects ?? []).filter(isOwn).map((a) => ({
      uid: newUid(),
      name: a.name,
      aspectType: ref(a.aspectType?.id ?? "", "aspectType"),
      aspectId: a.aspectId,
    }));
    const fileAssignments = (t.fileAssignments ?? []).filter(isOwn).flatMap((fa) => {
      const fu = fileUid.get(fa.fileId);
      if (!fu) {
        warnings.push(`Asset type ${t.id}: file assignment "${fa.key}" references a file that was not read; it was dropped.`);
        return [];
      }
      return [{ key: fa.key, fileUid: fu }];
    });
    put(entityKey("assetType", uid), { kind: "assetType", tenantId: t.id, name: t.name, etag: t.etag });
    for (const v of variables) put(memberKey("variable", uid, v.uid), { kind: "variable", tenantId: t.id, name: v.name, ownerUid: uid });
    for (const a of aspects) {
      put(memberKey("aspect", uid, a.uid), { kind: "aspect", tenantId: t.id, name: a.name, ownerUid: uid, ...(a.aspectId ? { aspectId: a.aspectId } : {}) });
    }
    const def: AssetTypeDef = {
      uid,
      idSuffix,
      name: t.name,
      parent: ref(t.parentTypeId, "assetType"),
      instantiable: t.instantiable !== false,
      variables,
      aspects: aspects.map(({ uid: aUid, name, aspectType }) => ({ uid: aUid, name, aspectType })),
      fileAssignments,
      origin: origin(t.id),
      baseline: { idSuffix, instantiable: t.instantiable !== false },
    };
    const description = blankToUndefined(t.description);
    if (description !== undefined) def.description = description;
    return def;
  });

  // Files (contents optionally downloaded)
  const files: FileDef[] = [];
  const total = snapshot.files.length;
  let done = 0;
  for (const f of snapshot.files as AmFileMetadata[]) {
    const uid = fileUid.get(f.id)!;
    const def: FileDef = {
      uid,
      name: f.name,
      scope: f.scope ?? "private",
      mimeType: mimeForFileName(f.name) ?? "application/octet-stream",
      size: 0,
      sha256: "",
      blobId: "",
      origin: origin(f.id),
    };
    const description = blankToUndefined(f.description);
    if (description !== undefined) def.description = description;
    if (opts.includeFileContents && opts.transport && opts.blobs) {
      opts.onProgress?.(`Downloading ${f.name}…`, done, total);
      try {
        const res = await opts.transport.downloadFile(f.id);
        if (res.status >= 400) {
          warnings.push(`File ${f.name}: content could not be downloaded (HTTP ${res.status}).`);
        } else {
          const blob = base64ToBlob(res.body.contentBase64, res.body.mimeType);
          def.mimeType = res.body.mimeType || def.mimeType;
          def.size = blob.size;
          def.sha256 = await (opts.hash ?? sha256Hex)(blob);
          def.blobId = await opts.blobs.put(blob);
        }
      } catch (e) {
        warnings.push(`File ${f.name}: content could not be downloaded (${e instanceof Error ? e.message : String(e)}).`);
      }
    }
    done++;
    put(entityKey("file", uid), { kind: "file", tenantId: f.id, name: f.name, etag: f.etag, ...(def.sha256 ? { sha256: def.sha256 } : {}) });
    files.push(def);
  }

  // Assets
  const root = createRootAsset();
  const rootLoc = normalizeLocation(snapshot.root.location);
  const rootTz = snapshot.root.timezone;
  const byId = new Map(snapshot.assets.map((a) => [a.assetId, a]));
  const depth = depthIndex(snapshot);
  const ordered = [...snapshot.assets].sort((a, b) => (depth.get(a.assetId) ?? 0) - (depth.get(b.assetId) ?? 0));
  for (const a of ordered) assetUid.set(a.assetId, newUid());
  const assets: AssetDef[] = [root];
  // Tenants may show effective values; values equal to the type's default are not explicit.
  const typeById = new Map(allTypes(snapshot.assetTypes).map((t) => [lc(t.id), t]));
  const aspectTypeById = new Map(allTypes(snapshot.aspectTypes).map((t) => [lc(t.id), t]));
  const defaultsCache = new Map<string, { vars: Map<string, string>; aspects: Map<string, Map<string, string>> }>();
  const defaultsOf = (typeId: string) => {
    const cached = defaultsCache.get(lc(typeId));
    if (cached) return cached;
    const vars = new Map<string, string>();
    const aspects = new Map<string, Map<string, string>>();
    const seen = new Set<string>();
    let cur = typeById.get(lc(typeId));
    while (cur && !seen.has(lc(cur.id))) {
      seen.add(lc(cur.id));
      for (const v of cur.variables ?? []) if (v.defaultValue && !vars.has(lc(v.name))) vars.set(lc(v.name), v.defaultValue);
      for (const asp of cur.aspects ?? []) {
        const at = aspectTypeById.get(lc(asp.aspectType?.id ?? "")) ?? asp.aspectType;
        const m = new Map<string, string>();
        for (const v of at?.variables ?? []) if (v.defaultValue) m.set(lc(v.name), v.defaultValue);
        if (!aspects.has(lc(asp.name))) aspects.set(lc(asp.name), m);
      }
      cur = cur.parentTypeId ? typeById.get(lc(cur.parentTypeId)) : undefined;
    }
    const out = { vars, aspects };
    defaultsCache.set(lc(typeId), out);
    return out;
  };
  for (const a of ordered) {
    const uid = assetUid.get(a.assetId)!;
    const parentUid =
      a.parentId === snapshot.root.assetId ? ROOT_ASSET_UID : a.parentId ? assetUid.get(a.parentId) : undefined;
    if (!parentUid || !Number.isFinite(depth.get(a.assetId) ?? Number.POSITIVE_INFINITY)) {
      warnings.push(`Asset "${a.name}" (${a.assetId}) is not connected to the root in the read data and was skipped.`);
      continue;
    }
    const parentRes = a.parentId === snapshot.root.assetId ? snapshot.root : a.parentId ? byId.get(a.parentId) : undefined;
    const loc = normalizeLocation(a.location);
    const parentLoc = parentRes === snapshot.root ? rootLoc : normalizeLocation(parentRes?.location);
    const ownLocation = loc && !sameJson(loc, parentLoc) ? loc : undefined;
    const twinType = a.twinType ?? "performance";
    const timezone = a.timezone && a.timezone !== rootTz ? a.timezone : undefined;
    const def: AssetDef = {
      uid,
      name: a.name,
      type: ref(a.typeId, "assetType"),
      parentUid,
      twinType,
      variables: (a.variables ?? [])
        .filter((v) => defaultsOf(a.typeId).vars.get(lc(v.name)) !== v.value)
        .map((v) => ({ name: v.name, value: v.value })),
      aspects: (a.aspects ?? [])
        .map((x) => ({
          name: x.name,
          variables: (x.variables ?? [])
            .filter((v) => defaultsOf(a.typeId).aspects.get(lc(x.name))?.get(lc(v.name)) !== v.value)
            .map((v) => ({ name: v.name, value: v.value })),
        }))
        .filter((x) => x.variables.length > 0),
      fileAssignments: (a.fileAssignments ?? []).filter(isOwn).flatMap((fa) => {
        const fu = fileUid.get(fa.fileId);
        if (!fu) {
          warnings.push(`Asset "${a.name}": file assignment "${fa.key}" references a file that was not read; it was dropped.`);
          return [];
        }
        return [{ key: fa.key, fileUid: fu }];
      }),
      origin: origin(a.assetId),
      baseline: { twinType, ...(timezone ? { timezone } : {}) },
    };
    if (timezone) def.timezone = timezone;
    if (ownLocation) def.location = ownLocation;
    const externalId = blankToUndefined(a.externalId);
    if (externalId !== undefined) def.externalId = externalId;
    const description = blankToUndefined(a.description);
    if (description !== undefined) def.description = description;
    put(entityKey("asset", uid), { kind: "asset", tenantId: a.assetId, name: a.name, etag: a.etag });
    assets.push(def);
  }
  if (snapshot.root.typeId && lc(snapshot.root.typeId) !== ROOT_ASSET_TYPE_ID) {
    root.type = ref(snapshot.root.typeId, "assetType");
  }

  const types = allTypes(snapshot.assetTypes).length;
  if (types === 0) warnings.push("No asset types were read from the tenant.");
  for (const f of snapshot.partialFailures) {
    warnings.push(`Reading ${f.resource} page ${f.page} failed (HTTP ${f.status}: ${f.message}); the backup is incomplete.`);
  }

  const project: Project = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: projectId,
    name: opts.name,
    ...(opts.description ? { description: opts.description } : {}),
    createdAt: at,
    updatedAt: at,
    aspectTypes,
    assetTypes,
    assets,
    files,
    changelog: [{ at, summary: `Read from tenant ${snapshot.tenant} (${snapshot.readAt})` }],
  };
  const parsed = ProjectSchema.safeParse(project);
  if (!parsed.success) {
    throw new Error(`The converted project is not valid: ${formatZodIssues(parsed.error).slice(0, 5).join("; ")}`);
  }
  return {
    project: parsed.data,
    mapping,
    warnings,
    uids: { aspectTypes: aspectUid, assetTypes: assetTypeUid, assets: assetUid, files: fileUid },
  };
}
