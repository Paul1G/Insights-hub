// Project file (JSON) export and import.
//
// Envelope:
//   { format, formatVersion, schemaVersion, exportedAt, generator,
//     checksum: { algorithm: "SHA-256", value }, project, files? }
//
// The checksum is the hex SHA-256 of the canonical JSON (keys sorted
// recursively, `undefined` members dropped, no whitespace) of
// `{ project, files }` — `files` is absent when contents are not embedded.
//
// Sensitive data is never exported: deployment mappings, connection ids and
// tokens live outside the project document (Dexie `mappings`, backend), the
// project is re-parsed through its schema (unknown keys are dropped) and the
// author user ids of changelog entries are removed.

import { z } from "zod";
import { MigrationError, migrateProject } from "@/domain/migrate";
import { PROJECT_FORMAT, PROJECT_SCHEMA_VERSION, ProjectSchema, newUid, type Project } from "@/domain/model";
import { db } from "@/storage/db";
import { getFileBlob, saveProject, sha256Hex } from "@/storage/repository";
import { exportFileName } from "./download";

export const PROJECT_FILE_FORMAT_VERSION = 1;
export const GENERATOR_NAME = "Asset Model Studio";
export const GENERATOR_VERSION = "1.0.0";
export const PROJECT_FILE_EXTENSION = "amsproject.json";

export interface EmbeddedFile {
  uid: string;
  sha256: string;
  contentBase64: string;
}

export interface ProjectEnvelope {
  format: typeof PROJECT_FORMAT;
  formatVersion: number;
  schemaVersion: number;
  exportedAt: string;
  generator: { name: string; version: string };
  checksum: { algorithm: "SHA-256"; value: string };
  project: Project;
  files?: EmbeddedFile[];
}

const EmbeddedFileSchema = z.object({
  uid: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i, "Expected a hex SHA-256."),
  contentBase64: z.string(),
});

const EnvelopeSchema = z.object({
  format: z.literal(PROJECT_FORMAT),
  formatVersion: z.number().int().min(1),
  schemaVersion: z.number().int().min(0),
  exportedAt: z.string(),
  generator: z.object({ name: z.string(), version: z.string() }),
  checksum: z.object({
    algorithm: z.literal("SHA-256"),
    value: z.string().regex(/^[0-9a-f]{64}$/i, "Expected a hex SHA-256."),
  }),
  project: z.unknown(),
  files: z.array(EmbeddedFileSchema).optional(),
});

export type ProjectFileErrorCode =
  | "invalid-json"
  | "not-a-project"
  | "invalid-envelope"
  | "unsupported-version"
  | "checksum-mismatch"
  | "invalid-project"
  | "file-content-mismatch";

export class ProjectFileError extends Error {
  readonly code: ProjectFileErrorCode;
  readonly issues: string[];
  constructor(code: ProjectFileErrorCode, message: string, issues: string[] = []) {
    super(message);
    this.name = "ProjectFileError";
    this.code = code;
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Canonical JSON, hashing, base64
// ---------------------------------------------------------------------------

/** Deterministic JSON: object keys sorted, undefined members dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (value === undefined || typeof value === "function" || typeof value === "symbol") return "null";
    if (typeof value === "number" && !Number.isFinite(value)) return "null";
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined && typeof obj[k] !== "function")
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export async function sha256OfText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  return sha256Hex(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

export async function envelopeChecksum(project: unknown, files: unknown): Promise<string> {
  return sha256OfText(canonicalJson({ project, files }));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Copy of the project without sensitive data: unknown keys are dropped by the
 * schema, changelog authors (user ids) are removed and tenant origins keep no
 * reference that looks like a connection id.
 */
export function sanitizeProjectForExport(project: Project): Project {
  const parsed = ProjectSchema.safeParse(structuredClone(project));
  const p: Project = parsed.success ? parsed.data : structuredClone(project);
  p.changelog = p.changelog.map(({ at, summary }) => ({ at, summary }));
  const scrub = (e: { origin?: Project["files"][number]["origin"] }) => {
    if (e.origin?.source === "tenant" && e.origin.ref && UUID.test(e.origin.ref)) delete e.origin.ref;
  };
  for (const list of [p.aspectTypes, p.assetTypes, p.assets, p.files]) for (const e of list) scrub(e);
  return p;
}

export interface ExportOptions {
  /** Embed file contents (base64) so the file is fully self-contained. */
  embedFiles: boolean;
  /** Blob loader, defaults to the local blob store. */
  loadBlob?: (blobId: string) => Promise<Blob | undefined>;
  now?: Date;
}

export interface ExportResult {
  envelope: ProjectEnvelope;
  /** Names of files whose content was requested but is not stored locally. */
  missingContents: string[];
}

export async function buildProjectEnvelope(project: Project, opts: ExportOptions): Promise<ExportResult> {
  const clean = sanitizeProjectForExport(project);
  const missingContents: string[] = [];
  let files: EmbeddedFile[] | undefined;
  if (opts.embedFiles) {
    const load = opts.loadBlob ?? getFileBlob;
    files = [];
    for (const f of clean.files) {
      const blob = await load(f.blobId);
      if (!blob) {
        missingContents.push(f.name);
        continue;
      }
      const buf = await blob.arrayBuffer();
      files.push({ uid: f.uid, sha256: await sha256Hex(buf), contentBase64: bytesToBase64(new Uint8Array(buf)) });
    }
  }
  const envelope: ProjectEnvelope = {
    format: PROJECT_FORMAT,
    formatVersion: PROJECT_FILE_FORMAT_VERSION,
    schemaVersion: clean.schemaVersion,
    exportedAt: (opts.now ?? new Date()).toISOString(),
    generator: { name: GENERATOR_NAME, version: GENERATOR_VERSION },
    checksum: { algorithm: "SHA-256", value: await envelopeChecksum(clean, files) },
    project: clean,
    ...(files ? { files } : {}),
  };
  return { envelope, missingContents };
}

export function serializeEnvelope(envelope: ProjectEnvelope): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

/** Export the project as a self-describing JSON file. */
export async function exportProjectFile(project: Project, opts: ExportOptions): Promise<Blob> {
  const { envelope } = await buildProjectEnvelope(project, opts);
  return new Blob([serializeEnvelope(envelope)], { type: "application/json" });
}

/** Suggested file name: `<slug>-<YYYY-MM-DD>.amsproject.json`. */
export function projectFileName(project: Pick<Project, "name">, at: Date = new Date()): string {
  return exportFileName(project.name, PROJECT_FILE_EXTENSION, undefined, at);
}

/**
 * Size estimate of the exported file in bytes (UTF-8 approximated by UTF-16
 * length; embedded contents grow by 4/3 through base64).
 */
export function estimateProjectFileSize(project: Project, embedFiles: boolean): number {
  const base = JSON.stringify(project, null, 2).length + 600;
  if (!embedFiles) return base;
  return project.files.reduce((n, f) => n + Math.ceil(f.size / 3) * 4 + f.uid.length + 140, base);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ImportOptions {
  /** Accept a checksum mismatch (tampered/edited file) with a warning instead of an error. */
  allowChecksumMismatch?: boolean;
  /** Name for the imported project (defaults to the name in the file). */
  name?: string;
  now?: Date;
}

export interface ParsedProjectFile {
  /** Migrated project, ids as in the file. */
  project: Project;
  /** Embedded contents keyed by file uid (verified against their sha256). */
  contents: Map<string, Uint8Array>;
  warnings: string[];
  envelope?: { exportedAt: string; generator: { name: string; version: string }; formatVersion: number };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function looksLikeProject(v: Record<string, unknown>): boolean {
  return "assets" in v || "assetTypes" in v || "aspectTypes" in v;
}

function migrate(raw: unknown): Project {
  try {
    return migrateProject(raw);
  } catch (e) {
    if (e instanceof MigrationError) {
      throw new ProjectFileError(
        e.message.includes("newer") ? "unsupported-version" : "invalid-project",
        e.message,
        e.issues,
      );
    }
    throw e;
  }
}

/** Parse, validate, verify and migrate a project file (no persistence). */
export async function parseProjectFile(text: string, opts: ImportOptions = {}): Promise<ParsedProjectFile> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProjectFileError("invalid-json", "The file is not valid JSON.");
  }
  if (!isRecord(raw)) throw new ProjectFileError("not-a-project", "The file does not contain a project.");
  const warnings: string[] = [];

  if (!("format" in raw)) {
    if (!looksLikeProject(raw)) throw new ProjectFileError("not-a-project", "The file does not contain an Asset Model Studio project.");
    warnings.push(
      "The file is a bare project without export envelope: its integrity cannot be verified and it contains no file contents.",
    );
    const project = migrate(raw);
    if (project.files.length) {
      warnings.push(`${project.files.length} file(s) have no content in this file; upload them again on the Files page.`);
    }
    return { project, contents: new Map(), warnings };
  }

  if (raw.format !== PROJECT_FORMAT) {
    throw new ProjectFileError("not-a-project", `Unknown file format "${String(raw.format)}" (expected ${PROJECT_FORMAT}).`);
  }
  if (typeof raw.formatVersion === "number" && raw.formatVersion > PROJECT_FILE_FORMAT_VERSION) {
    throw new ProjectFileError(
      "unsupported-version",
      `The project file uses format version ${raw.formatVersion}, which is newer than this app supports (${PROJECT_FILE_FORMAT_VERSION}).`,
    );
  }
  const parsed = EnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProjectFileError(
      "invalid-envelope",
      "The project file envelope is invalid.",
      parsed.error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  const env = parsed.data;
  if (env.schemaVersion > PROJECT_SCHEMA_VERSION) {
    throw new ProjectFileError(
      "unsupported-version",
      `The project uses schema version ${env.schemaVersion}, which is newer than this app supports (${PROJECT_SCHEMA_VERSION}).`,
    );
  }

  const actual = await envelopeChecksum(env.project, env.files);
  if (actual.toLowerCase() !== env.checksum.value.toLowerCase()) {
    if (!opts.allowChecksumMismatch) {
      throw new ProjectFileError(
        "checksum-mismatch",
        "The checksum does not match the content: the file was modified or damaged after export.",
      );
    }
    warnings.push("The checksum does not match the content (the file was modified after export); imported anyway.");
  }

  const project = migrate(env.project);
  if (isRecord(env.project) && env.project.schemaVersion !== project.schemaVersion) {
    warnings.push(
      `The project was migrated from schema version ${String(env.project.schemaVersion ?? 0)} to ${project.schemaVersion}.`,
    );
  }

  const contents = new Map<string, Uint8Array>();
  const byUid = new Map(project.files.map((f) => [f.uid, f]));
  for (const entry of env.files ?? []) {
    const file = byUid.get(entry.uid);
    if (!file) {
      warnings.push(`Embedded content for an unknown file (${entry.uid}) was ignored.`);
      continue;
    }
    let bytes: Uint8Array | undefined;
    try {
      bytes = base64ToBytes(entry.contentBase64);
    } catch {
      bytes = undefined;
    }
    const digest = bytes
      ? await sha256Hex(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
      : "";
    const ok = !!bytes && digest === entry.sha256.toLowerCase() && digest === file.sha256.toLowerCase();
    if (!ok) {
      if (!opts.allowChecksumMismatch) {
        throw new ProjectFileError(
          "file-content-mismatch",
          `The embedded content of "${file.name}" does not match its SHA-256 checksum.`,
        );
      }
      warnings.push(`The embedded content of "${file.name}" does not match its checksum and was not restored.`);
      continue;
    }
    contents.set(file.uid, bytes!);
  }
  const missing = project.files.filter((f) => !contents.has(f.uid));
  if (missing.length) {
    const names = missing.slice(0, 10).map((f) => `"${f.name}"`).join(", ");
    warnings.push(
      `${missing.length} file(s) have no content in this file (${names}${missing.length > 10 ? ", …" : ""}); upload them again on the Files page.`,
    );
  }
  return {
    project,
    contents,
    warnings,
    envelope: { exportedAt: env.exportedAt, generator: env.generator, formatVersion: env.formatVersion },
  };
}

/**
 * Give an imported project a fresh identity: new project id and new blob ids,
 * so it never collides with the project it was exported from.
 */
export function reidentifyImportedProject(parsed: ParsedProjectFile, opts: ImportOptions = {}): {
  project: Project;
  blobs: { id: string; bytes: Uint8Array; mimeType: string }[];
} {
  const at = (opts.now ?? new Date()).toISOString();
  const project = structuredClone(parsed.project);
  project.id = newUid();
  if (opts.name?.trim()) project.name = opts.name.trim();
  project.updatedAt = at;
  const blobs: { id: string; bytes: Uint8Array; mimeType: string }[] = [];
  for (const f of project.files) {
    const content = parsed.contents.get(f.uid);
    f.blobId = newUid();
    if (content) blobs.push({ id: f.blobId, bytes: content, mimeType: f.mimeType });
  }
  const source = parsed.envelope ? ` (exported ${parsed.envelope.exportedAt})` : "";
  project.changelog.push({ at, summary: `Imported from project file${source}` });
  return { project, blobs };
}

/** Import a project file as a new project (persisted). */
export async function importProjectFile(
  file: File | Blob,
  opts: ImportOptions = {},
): Promise<{ project: Project; warnings: string[] }> {
  const parsed = await parseProjectFile(await file.text(), opts);
  const { project, blobs } = reidentifyImportedProject(parsed, opts);
  await db.transaction("rw", db.fileBlobs, db.projects, db.projectDocs, async () => {
    for (const b of blobs) {
      await db.fileBlobs.put({ id: b.id, projectId: project.id, blob: new Blob([b.bytes as BlobPart], { type: b.mimeType }) });
    }
    await saveProject(project);
  });
  return { project, warnings: parsed.warnings };
}
