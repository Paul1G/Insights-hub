// Read a whole tenant (root, types, assets, files) into a TenantSnapshot.
//
// Lists go through Transport.listAll, which the proxy implements with
// size=200 pages fetched concurrently (docs/reference/pagination.txt and the
// page-size recommendation in overview-and-modelling-guidelines.txt). Pages
// that still fail after retries are reported as partial failures instead of
// aborting the read.

import { UpstreamError, type ListResource } from "@/api/client";
import type {
  AmAspectTypeResource,
  AmAssetResource,
  AmAssetTypeResource,
  AmFileMetadata,
} from "@/api/amTypes";
import type { Transport } from "@/deploy/transport";

export type TypeOrigin = "tenant" | "core" | "external";

export interface TypeGroups<T> {
  /** Types owned by the tenant (`<tenant>.*`). */
  tenant: T[];
  /** Out-of-the-box types (`core.*`). */
  core: T[];
  /** Shared types / types of other tenants. */
  external: T[];
}

export interface PartialFailure {
  resource: ListResource;
  page: number;
  status: number;
  message: string;
}

export interface TenantSnapshot {
  tenant: string;
  root: AmAssetResource;
  aspectTypes: TypeGroups<AmAspectTypeResource>;
  assetTypes: TypeGroups<AmAssetTypeResource>;
  /** All non-deleted assets except the root. */
  assets: AmAssetResource[];
  files: AmFileMetadata[];
  readAt: string;
  /** Whether assets / files were read (a types-only read leaves them empty). */
  includes: { assets: boolean; files: boolean };
  partialFailures: PartialFailure[];
}

export type ReadPhase = "root" | "aspectTypes" | "assetTypes" | "assets" | "files" | "done";

export interface ReadProgress {
  phase: ReadPhase;
  message: string;
  counts: { aspectTypes: number; assetTypes: number; assets: number; files: number };
}

export interface ReadTenantOptions {
  /** Tenant name used to compose type ids (`<tenant>.<idSuffix>`). */
  tenant: string;
  includeAssets?: boolean;
  includeFiles?: boolean;
  /** Also list types shared with this tenant (includeShared=true). */
  includeShared?: boolean;
  onProgress?: (p: ReadProgress) => void;
  now?: () => string;
}

export function classifyTypeId(id: string, tenant: string): TypeOrigin {
  const lower = id.toLowerCase();
  if (lower.startsWith("core.")) return "core";
  if (tenant && lower.startsWith(`${tenant.toLowerCase()}.`)) return "tenant";
  return "external";
}

export function groupTypes<T extends { id: string }>(items: T[], tenant: string): TypeGroups<T> {
  const groups: TypeGroups<T> = { tenant: [], core: [], external: [] };
  for (const item of items) groups[classifyTypeId(item.id, tenant)].push(item);
  return groups;
}

export function allTypes<T>(groups: TypeGroups<T>): T[] {
  return [...groups.tenant, ...groups.core, ...groups.external];
}

export async function readTenant(transport: Transport, opts: ReadTenantOptions): Promise<TenantSnapshot> {
  const includeAssets = opts.includeAssets ?? true;
  const includeFiles = opts.includeFiles ?? true;
  const counts = { aspectTypes: 0, assetTypes: 0, assets: 0, files: 0 };
  const partialFailures: PartialFailure[] = [];
  const progress = (phase: ReadPhase, message: string) => opts.onProgress?.({ phase, message, counts: { ...counts } });

  progress("root", "Reading the root asset (GET /assets/root)…");
  const rootRes = await transport.request<AmAssetResource>({ method: "GET", path: "/assets/root" });
  if (rootRes.status >= 400) throw new UpstreamError(rootRes.status, rootRes.body);
  const root = rootRes.body;

  const list = async <T,>(resource: ListResource, extra: { includeShared?: boolean } = {}): Promise<T[]> => {
    const res = await transport.listAll<T>({ resource, ...extra });
    for (const f of res.partialFailures) partialFailures.push({ resource, ...f });
    return res.items;
  };

  progress("aspectTypes", "Reading aspect types…");
  const aspectTypes = await list<AmAspectTypeResource>("aspecttypes", { includeShared: opts.includeShared });
  counts.aspectTypes = aspectTypes.length;

  progress("assetTypes", "Reading asset types…");
  const assetTypes = await list<AmAssetTypeResource>("assettypes", { includeShared: opts.includeShared });
  counts.assetTypes = assetTypes.length;

  let assets: AmAssetResource[] = [];
  if (includeAssets) {
    progress("assets", "Reading assets…");
    assets = (await list<AmAssetResource>("assets")).filter((a) => !a.deleted && a.assetId !== root.assetId);
    counts.assets = assets.length;
  }

  let files: AmFileMetadata[] = [];
  if (includeFiles) {
    progress("files", "Reading file metadata…");
    files = await list<AmFileMetadata>("files");
    counts.files = files.length;
  }

  progress("done", "Tenant read completed.");
  return {
    tenant: opts.tenant,
    root,
    aspectTypes: groupTypes(aspectTypes, opts.tenant),
    assetTypes: groupTypes(assetTypes, opts.tenant),
    assets,
    files,
    readAt: opts.now?.() ?? new Date().toISOString(),
    includes: { assets: includeAssets, files: includeFiles },
    partialFailures,
  };
}
