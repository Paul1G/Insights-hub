// IndexedDB persistence (Dexie). Everything the offline builder needs lives
// here so the app works without network and survives reloads.

import Dexie, { type Table } from "dexie";
import type { CoreLibrary } from "@/domain/coreLibrary";
import type { AspectTypeDef, AssetTypeDef, Project } from "@/domain/model";
import type { TenantSnapshot } from "@/tenant/read";

export interface ProjectCounts {
  aspectTypes: number;
  assetTypes: number;
  assets: number;
  files: number;
}

export interface ProjectMeta {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  counts: ProjectCounts;
}

export interface ProjectDoc {
  id: string;
  project: Project;
}

export interface SnapshotRecord {
  id: string;
  projectId: string;
  label: string;
  createdAt: string;
  /** Automatic snapshots (e.g. before a deployment or an import). */
  auto: boolean;
  counts: ProjectCounts;
  project: Project;
}

export interface FileBlobRecord {
  id: string;
  projectId: string;
  blob: Blob;
}

export interface UserLibrary {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  aspectTypes: AspectTypeDef[];
  /** Asset types may reference aspect types of the same library (kind "project"). */
  assetTypes: AssetTypeDef[];
}

export interface CoreLibraryRecord {
  id: "current";
  library: CoreLibrary;
}

export interface SettingRecord {
  key: string;
  value: unknown;
}

export type MappingKind = "aspectType" | "assetType" | "asset" | "file" | "variable" | "aspect";

/** Where a project entity lives in one particular tenant. */
export interface MappingEntry {
  kind: MappingKind;
  /** Tenant id: type id, assetId, fileId; for variables/aspects the owner's tenant id. */
  tenantId: string;
  /** Name as deployed (variables/aspects: used to detect renames). */
  name?: string;
  /** For variables/aspects: uid of the owning type. */
  ownerUid?: string;
  /** Platform aspectId of an asset type aspect (needed to rename aspects). */
  aspectId?: string;
  etag?: number;
  /** Files: hex SHA-256 of the content as deployed (detects content changes on redeploy). */
  sha256?: string;
  /**
   * Set when the entry was created by reading the tenant (backup / import),
   * not by deploying. Sync mode never deletes such objects physically; the
   * flag disappears once this project deploys the entity.
   */
  imported?: boolean;
  deployedAt: string;
}

export interface MappingRecord {
  /** `${projectId}:${connectionId}` */
  id: string;
  projectId: string;
  connectionId: string;
  /** Tenant name used to compose type ids for this target. */
  tenant: string;
  entries: Record<string, MappingEntry>;
  updatedAt: string;
}

export type DeploymentStatus =
  | "planned"
  | "running"
  | "paused"
  | "completed"
  | "completed-with-errors"
  | "failed"
  | "rolled-back"
  | "cancelled";

/**
 * A deployment run. `plan` and `steps` are owned by the deployment engine
 * (src/deploy) which parses them with its own schemas.
 */
export interface DeploymentRunRecord {
  id: string;
  projectId: string;
  connectionId: string;
  connectionName: string;
  tenant: string;
  mode: "deploy" | "sync" | "rollback" | "copy";
  status: DeploymentStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  plan: unknown;
  steps: unknown;
  report?: unknown;
}

/**
 * Cached read of a tenant's existing model (all types and assets), per
 * connection. Lets projects reference and import existing tenant objects,
 * also while offline.
 */
export interface TenantCatalogRecord {
  connectionId: string;
  connectionName: string;
  tenant: string;
  readAt: string;
  snapshot: TenantSnapshot;
}

export class StudioDb extends Dexie {
  projects!: Table<ProjectMeta, string>;
  projectDocs!: Table<ProjectDoc, string>;
  snapshots!: Table<SnapshotRecord, string>;
  fileBlobs!: Table<FileBlobRecord, string>;
  userLibraries!: Table<UserLibrary, string>;
  coreLibrary!: Table<CoreLibraryRecord, string>;
  settings!: Table<SettingRecord, string>;
  mappings!: Table<MappingRecord, string>;
  deployments!: Table<DeploymentRunRecord, string>;
  tenantCatalogs!: Table<TenantCatalogRecord, string>;

  constructor(name = "asset-model-studio") {
    super(name);
    this.version(1).stores({
      projects: "id, name, updatedAt",
      projectDocs: "id",
      snapshots: "id, projectId, createdAt",
      fileBlobs: "id, projectId",
      userLibraries: "id, name, updatedAt",
      coreLibrary: "id",
      settings: "key",
      mappings: "id, projectId, connectionId",
      deployments: "id, projectId, connectionId, createdAt, status",
    });
    this.version(2).stores({
      tenantCatalogs: "connectionId, readAt",
    });
  }
}

export const db = new StudioDb();
