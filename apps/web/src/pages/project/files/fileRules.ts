// Pure rules for project files (Files API constraints from the AM v3 spec):
// name pattern ^[^*&%\s/\\]+$ (≤ 255), description ≤ 255, content ≤ 5 MB,
// content type consistent with the extension.

import { checkContentType, mimeForFileName, type MimeCheck } from "@/domain/mime";
import { LIMITS, PATTERNS } from "@/domain/rules";

/** Replace whitespace and characters the Files API rejects with "_". */
export function sanitizeFileName(name: string): string {
  const cleaned = name.trim().replace(/[*&%\s/\\]+/g, "_");
  return cleaned.slice(0, LIMITS.fileNameMax) || "file";
}

export function fileNameError(name: string, otherNames: string[] = []): string | undefined {
  if (!name) return "File name is required.";
  if (!PATTERNS.fileName.test(name)) return "File names must not contain whitespace or any of * & % / \\.";
  if (name.length > LIMITS.fileNameMax) return `File name is longer than ${LIMITS.fileNameMax} characters.`;
  if (otherNames.some((n) => n.toLowerCase() === name.toLowerCase())) return "Another file has the same name; deployments match files by name.";
  return undefined;
}

export function fileDescriptionError(description: string): string | undefined {
  return description.length > LIMITS.fileDescriptionMax ? `Description is longer than ${LIMITS.fileDescriptionMax} characters.` : undefined;
}

/** Content type for an upload: the browser's type, else the one registered for the extension. */
export function contentTypeFor(fileName: string, browserType: string): string {
  return browserType || mimeForFileName(fileName) || "application/octet-stream";
}

export function mimeMessage(check: MimeCheck, mimeType: string): string | undefined {
  if (check.ok) return undefined;
  if (check.reason === "no-extension") return "The file name has no extension, so the platform cannot verify the content type.";
  if (check.reason === "unknown-extension") return `Unknown extension — the platform may reject content type ${mimeType}.`;
  return `Content type ${mimeType} does not match the extension (expected ${check.expected?.join(" or ")}).`;
}

export interface UploadCheck {
  name: string;
  mimeType: string;
  /** Blocking problem: the file is not added. */
  error?: string;
  /** Non-blocking notes (renamed, unverifiable content type). */
  notes: string[];
}

/** Validate a file chosen for upload (or for replacing the content of `targetName`). */
export function checkUpload(file: { name: string; type: string; size: number }, targetName?: string): UploadCheck {
  const notes: string[] = [];
  const name = targetName ?? sanitizeFileName(file.name);
  if (!targetName && name !== file.name) notes.push(`Renamed to “${name}” (the Files API does not allow whitespace or * & % / \\).`);
  const mimeType = contentTypeFor(name, file.type);
  if (file.size > LIMITS.fileSizeMaxBytes) {
    return { name, mimeType, notes, error: `${file.name} is larger than 5 MB, the maximum file size of the API.` };
  }
  const check = checkContentType(name, mimeType);
  const msg = mimeMessage(check, mimeType);
  if (!check.ok && check.reason === "mismatch") return { name, mimeType, notes, error: `${file.name}: ${msg}` };
  if (msg) notes.push(msg);
  return { name, mimeType, notes };
}

/** Make a name unique among existing file names (case-insensitive): a_2.pdf, a_3.pdf, … */
export function uniqueFileName(name: string, existing: Iterable<string>): string {
  const taken = new Set([...existing].map((n) => n.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
