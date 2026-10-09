// User libraries: reusable sets of aspect types and asset types.
//
// - A library is created from a selection in a project with dependency
//   closure: asset types pull in their project parent chain and every project
//   aspect type they reference, so the library is self-contained.
// - Libraries are tenant-independent: baselines, origins and file assignments
//   (files are project content, not library content) are stripped.
// - Inserting a library into a project copies every type with fresh uids,
//   remaps the library-internal references, resolves name / id conflicts
//   case-insensitively (the platform treats names case-insensitively) and
//   reports every rename.
// - Export/import uses a self-describing JSON envelope with a SHA-256
//   checksum over the canonical JSON of the library, so tampering or
//   corruption is detected on import.

import { z } from "zod";
import { formatZodIssues } from "@/domain/migrate";
import {
  AspectTypeDefSchema,
  AssetTypeDefSchema,
  newUid,
  nowIso,
  type AspectTypeDef,
  type AssetTypeDef,
  type Project,
  type TypeRef,
  type VariableDef,
} from "@/domain/model";
import { DomainError, toIdentifier, uniqueName } from "@/domain/ops";
import type { UserLibrary } from "@/storage/db";
import { sha256Hex } from "@/storage/repository";

export const LIBRARY_FORMAT = "asset-model-studio/library";
export const LIBRARY_FORMAT_VERSION = 1;

export interface LibrarySelection {
  aspectTypeUids: string[];
  assetTypeUids: string[];
}

export interface LibraryClosure {
  aspectTypes: AspectTypeDef[];
  assetTypes: AssetTypeDef[];
  /** Names of aspect types that were not selected but are required by selected asset types. */
  addedAspectTypes: string[];
  /** Names of project parent types that were not selected but are required by selected asset types. */
  addedAssetTypes: string[];
  /** File assignments that are not carried into the library. */
  droppedFileAssignments: number;
}

const lc = (s: string) => s.toLowerCase();

function stripVariable(v: VariableDef): VariableDef {
  const copy = structuredClone(v);
  delete copy.baseline;
  return copy;
}

function stripAspectType(t: AspectTypeDef): AspectTypeDef {
  const copy = structuredClone(t);
  delete copy.baseline;
  delete copy.origin;
  copy.variables = copy.variables.map(stripVariable);
  return copy;
}

function stripAssetType(t: AssetTypeDef): AssetTypeDef {
  const copy = structuredClone(t);
  delete copy.baseline;
  delete copy.origin;
  copy.variables = copy.variables.map(stripVariable);
  copy.fileAssignments = [];
  return copy;
}

/** Selected types plus everything they depend on inside the project. */
export function libraryClosure(project: Project, selection: LibrarySelection): LibraryClosure {
  const assetTypes = new Map(project.assetTypes.map((t) => [t.uid, t]));
  const aspectTypes = new Map(project.aspectTypes.map((t) => [t.uid, t]));

  const assetSet = new Set<string>();
  const addedAssets = new Set<string>();
  const selectedAssets = new Set(selection.assetTypeUids.filter((u) => assetTypes.has(u)));
  for (const uid of selectedAssets) {
    assetSet.add(uid);
    let cur = assetTypes.get(uid);
    const seen = new Set<string>([uid]);
    while (cur && cur.parent.kind === "project") {
      const parentUid = cur.parent.uid;
      if (seen.has(parentUid)) break;
      seen.add(parentUid);
      const parent = assetTypes.get(parentUid);
      if (!parent) break;
      if (!selectedAssets.has(parentUid)) addedAssets.add(parentUid);
      assetSet.add(parentUid);
      cur = parent;
    }
  }

  const selectedAspects = new Set(selection.aspectTypeUids.filter((u) => aspectTypes.has(u)));
  const aspectSet = new Set(selectedAspects);
  const addedAspects = new Set<string>();
  let droppedFileAssignments = 0;
  for (const uid of assetSet) {
    const t = assetTypes.get(uid)!;
    droppedFileAssignments += t.fileAssignments.length;
    for (const a of t.aspects) {
      if (a.aspectType.kind !== "project" || !aspectTypes.has(a.aspectType.uid)) continue;
      if (!selectedAspects.has(a.aspectType.uid)) addedAspects.add(a.aspectType.uid);
      aspectSet.add(a.aspectType.uid);
    }
  }

  return {
    // Keep the project order so the library reads like the project.
    aspectTypes: project.aspectTypes.filter((t) => aspectSet.has(t.uid)).map(stripAspectType),
    assetTypes: project.assetTypes.filter((t) => assetSet.has(t.uid)).map(stripAssetType),
    addedAspectTypes: [...addedAspects].map((u) => aspectTypes.get(u)!.name),
    addedAssetTypes: [...addedAssets].map((u) => assetTypes.get(u)!.name),
    droppedFileAssignments,
  };
}

export function createUserLibrary(name: string, description: string | undefined, closure: LibraryClosure): UserLibrary {
  const at = nowIso();
  return {
    id: newUid(),
    name,
    ...(description ? { description } : {}),
    createdAt: at,
    updatedAt: at,
    aspectTypes: closure.aspectTypes,
    assetTypes: closure.assetTypes,
  };
}

type LibraryContent = Pick<UserLibrary, "name" | "aspectTypes" | "assetTypes">;

/** References inside the library that point to project types the library does not contain. */
export function libraryIntegrityErrors(lib: Pick<UserLibrary, "aspectTypes" | "assetTypes">): string[] {
  const errors: string[] = [];
  const assetUids = new Set(lib.assetTypes.map((t) => t.uid));
  const aspectUids = new Set(lib.aspectTypes.map((t) => t.uid));
  const allUids = [...lib.assetTypes.map((t) => t.uid), ...lib.aspectTypes.map((t) => t.uid)];
  if (new Set(allUids).size !== allUids.length) errors.push("The library contains duplicate type uids.");
  for (const t of lib.assetTypes) {
    if (t.parent.kind === "project" && !assetUids.has(t.parent.uid)) {
      errors.push(`Asset type "${t.name}" inherits from a project type that is not part of the library.`);
    }
    for (const a of t.aspects) {
      if (a.aspectType.kind === "project" && !aspectUids.has(a.aspectType.uid)) {
        errors.push(`Aspect "${a.name}" of "${t.name}" references an aspect type that is not part of the library.`);
      }
    }
  }
  return errors;
}

export interface LibraryRename {
  kind: "aspectType" | "assetType";
  field: "name" | "idSuffix";
  from: string;
  to: string;
}

export interface InsertReport {
  aspectTypes: { uid: string; name: string }[];
  assetTypes: { uid: string; name: string }[];
  renames: LibraryRename[];
}

/**
 * Copy a library into a project (draft, edited in place). Fresh uids for
 * every type, variable and aspect; library-internal references are remapped;
 * conflicting names / ids get a `_2`, `_3`, … suffix (case-insensitive).
 */
export function insertLibrary(d: Project, lib: LibraryContent, at: string = nowIso()): InsertReport {
  const integrity = libraryIntegrityErrors(lib);
  if (integrity.length) throw new DomainError(`The library is inconsistent: ${integrity[0]}`);

  const uidMap = new Map<string, string>();
  for (const t of [...lib.aspectTypes, ...lib.assetTypes]) uidMap.set(t.uid, newUid());
  const remap = (ref: TypeRef): TypeRef => (ref.kind === "project" ? { kind: "project", uid: uidMap.get(ref.uid)! } : { ...ref });
  const origin = { source: "library" as const, ref: lib.name, at };
  const renames: LibraryRename[] = [];

  const resolve = (kind: LibraryRename["kind"], field: LibraryRename["field"], value: string, taken: string[]) => {
    const next = uniqueName(value, taken);
    if (next !== value) renames.push({ kind, field, from: value, to: next });
    taken.push(next);
    return next;
  };
  const freshVariables = (vars: VariableDef[]) => vars.map((v) => ({ ...stripVariable(v), uid: newUid() }));

  const aspectNames = d.aspectTypes.map((t) => t.name);
  const aspectIds = d.aspectTypes.map((t) => t.idSuffix);
  const insertedAspects: AspectTypeDef[] = lib.aspectTypes.map((t) => {
    const copy = stripAspectType(t);
    return {
      ...copy,
      uid: uidMap.get(t.uid)!,
      name: resolve("aspectType", "name", t.name, aspectNames),
      idSuffix: resolve("aspectType", "idSuffix", t.idSuffix, aspectIds),
      variables: freshVariables(copy.variables),
      origin,
    };
  });

  const assetNames = d.assetTypes.map((t) => t.name);
  const assetIds = d.assetTypes.map((t) => t.idSuffix);
  const insertedAssets: AssetTypeDef[] = lib.assetTypes.map((t) => {
    const copy = stripAssetType(t);
    return {
      ...copy,
      uid: uidMap.get(t.uid)!,
      name: resolve("assetType", "name", t.name, assetNames),
      idSuffix: resolve("assetType", "idSuffix", t.idSuffix, assetIds),
      parent: remap(t.parent),
      variables: freshVariables(copy.variables),
      aspects: copy.aspects.map((a) => ({ uid: newUid(), name: a.name, aspectType: remap(a.aspectType) })),
      fileAssignments: [],
      origin,
    };
  });

  d.aspectTypes.push(...insertedAspects);
  d.assetTypes.push(...insertedAssets);
  return {
    aspectTypes: insertedAspects.map((t) => ({ uid: t.uid, name: t.name })),
    assetTypes: insertedAssets.map((t) => ({ uid: t.uid, name: t.name })),
    renames,
  };
}

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

/** JSON with recursively sorted object keys and no whitespace (undefined members dropped, like JSON.stringify). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined || typeof v === "function" ? "null" : canonicalJson(v))).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined || typeof v === "function") continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(v)}`);
  }
  return `{${parts.join(",")}}`;
}

export async function libraryChecksum(library: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(library));
  return sha256Hex(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

export interface LibraryExportFile {
  format: typeof LIBRARY_FORMAT;
  formatVersion: typeof LIBRARY_FORMAT_VERSION;
  exportedAt: string;
  checksum: { algorithm: "SHA-256"; value: string };
  library: UserLibrary;
}

export async function exportLibrary(library: UserLibrary, at: string = nowIso()): Promise<LibraryExportFile> {
  // Round-trip through JSON so the checksum covers exactly what is written.
  const plain = JSON.parse(JSON.stringify(library)) as UserLibrary;
  return {
    format: LIBRARY_FORMAT,
    formatVersion: LIBRARY_FORMAT_VERSION,
    exportedAt: at,
    checksum: { algorithm: "SHA-256", value: await libraryChecksum(plain) },
    library: plain,
  };
}

export function libraryFileName(library: Pick<UserLibrary, "name">): string {
  return `${toIdentifier(library.name, "library")}.library.json`;
}

export const UserLibrarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  aspectTypes: z.array(AspectTypeDefSchema),
  assetTypes: z.array(AssetTypeDefSchema),
});

const EnvelopeSchema = z.object({
  format: z.literal(LIBRARY_FORMAT),
  formatVersion: z.literal(LIBRARY_FORMAT_VERSION),
  exportedAt: z.string(),
  checksum: z.object({
    algorithm: z.literal("SHA-256"),
    value: z.string().regex(/^[0-9a-f]{64}$/i, "Checksum must be 64 hexadecimal characters."),
  }),
  library: z.unknown(),
});

export type LibraryImportResult =
  | {
      ok: true;
      library: UserLibrary;
      exportedAt: string;
      checksumValid: boolean;
      expectedChecksum: string;
      actualChecksum: string;
    }
  | { ok: false; errors: string[] };

/** Parse and verify an exported library file. Never throws for invalid input. */
export async function parseLibraryFile(text: string): Promise<LibraryImportResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["The file is not valid JSON."] };
  }
  const envelope = EnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    const format = (raw as { format?: unknown } | null)?.format;
    if (format !== LIBRARY_FORMAT) {
      return { ok: false, errors: [`Not an Asset Model Studio library file (expected format "${LIBRARY_FORMAT}").`] };
    }
    return { ok: false, errors: formatZodIssues(envelope.error) };
  }
  const library = UserLibrarySchema.safeParse(envelope.data.library);
  if (!library.success) return { ok: false, errors: formatZodIssues(library.error) };
  const integrity = libraryIntegrityErrors(library.data);
  if (integrity.length) return { ok: false, errors: integrity };
  const actual = await libraryChecksum(envelope.data.library);
  const expected = envelope.data.checksum.value.toLowerCase();
  return {
    ok: true,
    library: library.data,
    exportedAt: envelope.data.exportedAt,
    checksumValid: actual === expected,
    expectedChecksum: expected,
    actualChecksum: actual,
  };
}

/** Prepare an imported library for storage: new id, unique name among the existing libraries. */
export function adoptImportedLibrary(library: UserLibrary, existingNames: string[], at: string = nowIso()): UserLibrary {
  return {
    ...library,
    id: newUid(),
    name: uniqueName(library.name, existingNames, " "),
    updatedAt: at,
  };
}

export function librarySummary(lib: Pick<UserLibrary, "aspectTypes" | "assetTypes">): string {
  const a = lib.aspectTypes.length;
  const t = lib.assetTypes.length;
  return `${t} asset type${t === 1 ? "" : "s"} · ${a} aspect type${a === 1 ? "" : "s"}`;
}

export function libraryNameTaken(name: string, existing: string[], exceptName?: string): boolean {
  return existing.some((n) => lc(n) === lc(name) && (exceptName === undefined || lc(n) !== lc(exceptName)));
}
