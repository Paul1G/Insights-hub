// Files API helpers: upload / replace validation (≤ 5 MB, content type must
// match the extension, name pattern), delete session (If-Match) and download.

import { base64ToBlob, blobToBase64, type AmResponse, type FileUploadInput } from "@/api/client";
import type { AmFileMetadata } from "@/api/amTypes";
import { checkContentType, fileExtension, knownExtensions, mimeForFileName } from "@/domain/mime";
import { LIMITS, PATTERNS } from "@/domain/rules";
import { diffValues, type Change } from "@/domain/diff";
import type { FieldErrors } from "./aspectTypes";
import { upstreamError } from "./errors";
import { fetchWithEtag, type EditSession } from "./etag";
import { amPath, type AmTransport } from "./transport";

export interface UploadForm {
  /** File name sent to the Files API. */
  name: string;
  description: string;
  scope: "private" | "public";
  file: File | null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/** Content type to send: the browser's type if it matches the extension, else the registered one. */
export function contentTypeFor(file: File): string | undefined {
  if (file.type && checkContentType(file.name, file.type).ok) return file.type;
  return mimeForFileName(file.name);
}

export function validateFileName(name: string): string | undefined {
  const n = name.trim();
  if (!n) return "Name is required.";
  if (n.length > LIMITS.fileNameMax) return `At most ${LIMITS.fileNameMax} characters.`;
  if (!PATTERNS.fileName.test(n)) return "No spaces and none of * & % / \\.";
  return undefined;
}

export function validateUpload(form: UploadForm, opts: { requireFile: boolean } = { requireFile: true }): FieldErrors {
  const e: FieldErrors = {};
  e.name = validateFileName(form.name);
  if (form.description.length > LIMITS.fileDescriptionMax) e.description = `At most ${LIMITS.fileDescriptionMax} characters.`;
  const f = form.file;
  if (!f) {
    if (opts.requireFile) e.file = "Choose a file.";
    return e;
  }
  if (f.size > LIMITS.fileSizeMaxBytes) {
    e.file = `The file is ${formatBytes(f.size)}; the maximum file size is ${formatBytes(LIMITS.fileSizeMaxBytes)}.`;
    return e;
  }
  if (f.size === 0) {
    e.file = "The file is empty.";
    return e;
  }
  const ext = fileExtension(f.name);
  const mime = contentTypeFor(f);
  if (!ext) e.file = "The file needs an extension (the content type is checked against it).";
  else if (!mime) e.file = `Unsupported extension .${ext}. Supported: ${knownExtensions().join(", ")}.`;
  else {
    const check = checkContentType(f.name, mime);
    if (!check.ok) e.file = `Content type ${mime} does not match .${ext}.`;
  }
  return e;
}

export async function uploadInput(form: UploadForm): Promise<FileUploadInput> {
  const f = form.file!;
  const input: FileUploadInput = {
    name: form.name.trim(),
    scope: form.scope,
    fileName: f.name,
    mimeType: contentTypeFor(f)!,
    contentBase64: await blobToBase64(f),
  };
  if (form.description.trim()) input.description = form.description.trim();
  return input;
}

export function decodeDownload(content: { mimeType: string; contentBase64: string }): Blob {
  return base64ToBlob(content.contentBase64, content.mimeType);
}

/** Browser download of a Blob (object URL revoked after the click). */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function projectFile(f: AmFileMetadata) {
  return {
    name: f.name,
    description: f.description ?? "",
    scope: f.scope ?? "private",
    originalFileName: f.originalFileName ?? "",
    lastModified: f.lastModified ?? "",
    isAssigned: !!f.isAssigned,
  };
}

export function fileDeleteSession(t: AmTransport, connectionId: string, original: AmFileMetadata): EditSession<AmFileMetadata> {
  return {
    fetch: () => fetchWithEtag<AmFileMetadata>(t, connectionId, amPath.file(original.id)),
    plan: (current) => [
      { label: "Delete file", build: (etag) => ({ method: "DELETE", path: amPath.file(current.id), ifMatch: etag }) },
    ],
    mine: projectFile(original),
    project: projectFile,
  };
}

export interface FileReplaceTransport {
  replace(
    connectionId: string,
    fileId: string,
    ifMatch: string | number,
    input: FileUploadInput,
  ): Promise<AmResponse<AmFileMetadata>>;
}

export type ReplaceResult =
  | { kind: "done"; file: AmFileMetadata }
  | { kind: "discarded" };

/**
 * PUT /files/{id} (multipart via the proxy) with If-Match. On 412 the current
 * metadata is read and `resolve` decides between re-sending on the fresh ETag
 * and discarding. Other failures throw UpstreamError.
 */
export async function replaceFileWithEtag(
  ft: FileReplaceTransport,
  t: AmTransport,
  connectionId: string,
  file: AmFileMetadata,
  input: FileUploadInput,
  resolve: (server: AmFileMetadata, changes: Change[]) => Promise<"overwrite" | "discard">,
  maxRounds = 3,
): Promise<ReplaceResult> {
  let etag: string | number = file.etag;
  for (let round = 0; round < maxRounds; round++) {
    const res = await ft.replace(connectionId, file.id, etag, input);
    if (res.status < 400) return { kind: "done", file: res.body };
    if (res.status !== 412) throw upstreamError(res.status, res.body);
    const fresh = await fetchWithEtag<AmFileMetadata>(t, connectionId, amPath.file(file.id));
    const mine = { ...projectFile(file), name: input.name, description: input.description ?? "", scope: input.scope ?? "private", originalFileName: input.fileName };
    const decision = await resolve(fresh.resource, diffValues(projectFile(fresh.resource), mine));
    if (decision === "discard") return { kind: "discarded" };
    etag = fresh.etag;
  }
  return { kind: "discarded" };
}
