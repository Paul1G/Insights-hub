// File content operations on the local blob store.

import { db } from "@/storage/db";
import { deleteFileBlob } from "@/storage/repository";

/**
 * Delete a blob unless a version snapshot of the project still references it
 * (restoring that snapshot would otherwise lose the file content).
 */
export async function deleteBlobIfUnreferenced(projectId: string, blobId: string): Promise<boolean> {
  const snapshots = await db.snapshots.where("projectId").equals(projectId).toArray();
  if (snapshots.some((s) => s.project.files.some((f) => f.blobId === blobId))) return false;
  await deleteFileBlob(blobId);
  return true;
}
