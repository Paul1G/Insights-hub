// Repository functions over the Dexie database: projects, snapshots, file
// blobs, settings, core library and user libraries.

import { BUILTIN_CORE_LIBRARY, type CoreLibrary } from "@/domain/coreLibrary";
import { migrateProject } from "@/domain/migrate";
import { createEmptyProject, newUid, nowIso, type Project } from "@/domain/model";
import { db, type ProjectCounts, type ProjectMeta, type SnapshotRecord, type UserLibrary } from "./db";

export function countsOf(p: Project): ProjectCounts {
  return {
    aspectTypes: p.aspectTypes.length,
    assetTypes: p.assetTypes.length,
    // The root placeholder is not counted as an asset.
    assets: Math.max(0, p.assets.length - 1),
    files: p.files.length,
  };
}

function metaOf(p: Project): ProjectMeta {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    counts: countsOf(p),
  };
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function listProjects(): Promise<ProjectMeta[]> {
  return db.projects.orderBy("updatedAt").reverse().toArray();
}

export async function saveProject(project: Project): Promise<void> {
  await db.transaction("rw", db.projects, db.projectDocs, async () => {
    await db.projectDocs.put({ id: project.id, project });
    await db.projects.put(metaOf(project));
  });
}

export async function createProject(name: string, description?: string): Promise<Project> {
  const project = createEmptyProject(name, description);
  await saveProject(project);
  return project;
}

/** Load and migrate a project. Returns undefined when it does not exist. */
export async function loadProject(id: string): Promise<Project | undefined> {
  const doc = await db.projectDocs.get(id);
  return doc ? migrateProject(doc.project) : undefined;
}

export async function renameProject(id: string, name: string, description?: string): Promise<void> {
  const project = await loadProject(id);
  if (!project) throw new Error("Project not found.");
  const at = nowIso();
  project.name = name;
  if (description !== undefined) project.description = description;
  project.updatedAt = at;
  project.changelog.push({ at, summary: `Renamed project to “${name}”` });
  await saveProject(project);
}

/** Deep-copy a project (incl. file blobs) under a new id. Deployment mappings are not copied. */
export async function cloneProject(id: string, name: string): Promise<Project> {
  const source = await loadProject(id);
  if (!source) throw new Error("Project not found.");
  const at = nowIso();
  const clone: Project = structuredClone(source);
  clone.id = newUid();
  clone.name = name;
  clone.createdAt = at;
  clone.updatedAt = at;
  clone.changelog = [{ at, summary: `Cloned from “${source.name}”` }];
  await db.transaction("rw", db.fileBlobs, db.projects, db.projectDocs, async () => {
    for (const f of clone.files) {
      const blob = await db.fileBlobs.get(f.blobId);
      const blobId = newUid();
      if (blob) await db.fileBlobs.put({ id: blobId, projectId: clone.id, blob: blob.blob });
      f.blobId = blobId;
    }
    await db.projectDocs.put({ id: clone.id, project: clone });
    await db.projects.put(metaOf(clone));
  });
  return clone;
}

/** Delete a project with its snapshots, blobs, mappings and deployment runs. */
export async function deleteProject(id: string): Promise<void> {
  await db.transaction(
    "rw",
    [db.projects, db.projectDocs, db.snapshots, db.fileBlobs, db.mappings, db.deployments],
    async () => {
      await db.projects.delete(id);
      await db.projectDocs.delete(id);
      await db.snapshots.where("projectId").equals(id).delete();
      await db.fileBlobs.where("projectId").equals(id).delete();
      await db.mappings.where("projectId").equals(id).delete();
      await db.deployments.where("projectId").equals(id).delete();
    },
  );
}

// ---------------------------------------------------------------------------
// Snapshots (versions)
// ---------------------------------------------------------------------------

export async function createSnapshot(project: Project, label: string, auto = false): Promise<SnapshotRecord> {
  const record: SnapshotRecord = {
    id: newUid(),
    projectId: project.id,
    label,
    createdAt: nowIso(),
    auto,
    counts: countsOf(project),
    project: structuredClone(project),
  };
  await db.snapshots.put(record);
  return record;
}

export async function listSnapshots(projectId: string): Promise<SnapshotRecord[]> {
  const list = await db.snapshots.where("projectId").equals(projectId).toArray();
  return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getSnapshot(id: string): Promise<SnapshotRecord | undefined> {
  const s = await db.snapshots.get(id);
  return s ? { ...s, project: migrateProject(s.project) } : undefined;
}

export async function deleteSnapshot(id: string): Promise<void> {
  await db.snapshots.delete(id);
}

// ---------------------------------------------------------------------------
// File blobs
// ---------------------------------------------------------------------------

export async function putFileBlob(projectId: string, blob: Blob): Promise<string> {
  const id = newUid();
  await db.fileBlobs.put({ id, projectId, blob });
  return id;
}

export async function getFileBlob(blobId: string): Promise<Blob | undefined> {
  return (await db.fileBlobs.get(blobId))?.blob;
}

export async function deleteFileBlob(blobId: string): Promise<void> {
  await db.fileBlobs.delete(blobId);
}

export async function sha256Hex(data: Blob | ArrayBuffer): Promise<string> {
  const buf = data instanceof Blob ? await data.arrayBuffer() : data;
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const rec = await db.settings.get(key);
  return rec === undefined ? fallback : (rec.value as T);
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  await db.settings.put({ key, value });
}

// ---------------------------------------------------------------------------
// Core library
// ---------------------------------------------------------------------------

export async function loadCoreLibrary(): Promise<CoreLibrary> {
  return (await db.coreLibrary.get("current"))?.library ?? BUILTIN_CORE_LIBRARY;
}

export async function saveCoreLibrary(library: CoreLibrary): Promise<void> {
  await db.coreLibrary.put({ id: "current", library });
}

export async function resetCoreLibrary(): Promise<void> {
  await db.coreLibrary.delete("current");
}

// ---------------------------------------------------------------------------
// User libraries
// ---------------------------------------------------------------------------

export async function listUserLibraries(): Promise<UserLibrary[]> {
  return db.userLibraries.orderBy("updatedAt").reverse().toArray();
}

export async function getUserLibrary(id: string): Promise<UserLibrary | undefined> {
  return db.userLibraries.get(id);
}

export async function saveUserLibrary(lib: UserLibrary): Promise<void> {
  await db.userLibraries.put({ ...lib, updatedAt: nowIso() });
}

export async function deleteUserLibrary(id: string): Promise<void> {
  await db.userLibraries.delete(id);
}
