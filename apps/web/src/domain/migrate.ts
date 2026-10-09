// Project schema migrations.
//
// Every persisted or imported project goes through migrateProject(), which
// upgrades older schema versions step by step and validates the result with
// the current Zod schema. Add a step to MIGRATIONS when bumping
// PROJECT_SCHEMA_VERSION.

import { z } from "zod";
import { PROJECT_SCHEMA_VERSION, ProjectSchema, ROOT_ASSET_UID, createRootAsset, type Project } from "./model";

export class MigrationError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = "MigrationError";
    this.issues = issues;
  }
}

type RawProject = Record<string, unknown>;

/**
 * Migration steps keyed by the version they upgrade *from*. Version 0 is the
 * pre-release shape without `schemaVersion`, `changelog` or `files`.
 */
const MIGRATIONS: Record<number, (p: RawProject) => RawProject> = {
  0: (p) => ({
    ...p,
    schemaVersion: 1,
    files: Array.isArray(p.files) ? p.files : [],
    changelog: Array.isArray(p.changelog) ? p.changelog : [],
    aspectTypes: Array.isArray(p.aspectTypes) ? p.aspectTypes : [],
    assetTypes: Array.isArray(p.assetTypes) ? p.assetTypes : [],
    assets: Array.isArray(p.assets) ? p.assets : [],
  }),
};

export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 50).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
}

/** Upgrade and validate an unknown value into a current Project. */
export function migrateProject(raw: unknown): Project {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new MigrationError("Not a project object.");
  }
  let p = raw as RawProject;
  let version = typeof p.schemaVersion === "number" ? p.schemaVersion : 0;
  if (version > PROJECT_SCHEMA_VERSION) {
    throw new MigrationError(
      `Project schema version ${version} is newer than this app supports (${PROJECT_SCHEMA_VERSION}).`,
    );
  }
  while (version < PROJECT_SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) throw new MigrationError(`No migration from schema version ${version}.`);
    p = step(p);
    version = p.schemaVersion as number;
  }
  if (Array.isArray(p.assets) && !p.assets.some((a) => (a as { uid?: unknown }).uid === ROOT_ASSET_UID)) {
    p = { ...p, assets: [createRootAsset(), ...p.assets] };
  }
  const parsed = ProjectSchema.safeParse(p);
  if (!parsed.success) {
    throw new MigrationError("The project does not match the expected schema.", formatZodIssues(parsed.error));
  }
  return parsed.data;
}
