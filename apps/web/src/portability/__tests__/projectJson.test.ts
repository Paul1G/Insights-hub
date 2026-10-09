/// <reference types="@vitest/browser/providers/playwright" />
import { afterEach, describe, expect, it } from "vitest";
import { PROJECT_FORMAT, createEmptyProject, type Project } from "@/domain/model";
import { db } from "@/storage/db";
import { deleteProject, getFileBlob, loadProject, sha256Hex } from "@/storage/repository";
import {
  ProjectFileError,
  buildProjectEnvelope,
  canonicalJson,
  envelopeChecksum,
  exportProjectFile,
  importProjectFile,
  parseProjectFile,
  projectFileName,
  sanitizeProjectForExport,
  serializeEnvelope,
} from "../projectJson";

const created: string[] = [];

afterEach(async () => {
  while (created.length) await deleteProject(created.pop()!);
});

function sampleProject(): Project {
  const p = createEmptyProject("Plant <A> & “B”");
  p.aspectTypes.push({
    uid: "apt-1",
    idSuffix: "Metrics",
    name: "Metrics",
    category: "dynamic",
    variables: [{ uid: "v-1", name: "rpm", dataType: "DOUBLE", unit: "1/min", searchable: false }],
  });
  p.assetTypes.push({
    uid: "at-1",
    idSuffix: "Pump",
    name: "Pump",
    parent: { kind: "core", id: "core.basicasset" },
    instantiable: true,
    variables: [{ uid: "v-2", name: "serial", dataType: "STRING", length: 64, searchable: true }],
    aspects: [{ uid: "asp-1", name: "metrics", aspectType: { kind: "project", uid: "apt-1" } }],
    fileAssignments: [],
  });
  p.assets.push({
    uid: "a-1",
    name: "Pump 1",
    type: { kind: "project", uid: "at-1" },
    parentUid: "root",
    twinType: "performance",
    variables: [{ name: "serial", value: "SN-1" }],
    aspects: [],
    fileAssignments: [],
  });
  p.changelog.push({ at: p.createdAt, summary: "Edited", author: "user-123" });
  return p;
}

async function withFile(p: Project, content: string): Promise<{ project: Project; blob: Blob }> {
  const blob = new Blob([content], { type: "text/plain" });
  const sha = await sha256Hex(blob);
  p.files.push({ uid: "f-1", name: "manual.txt", scope: "private", mimeType: "text/plain", size: blob.size, sha256: sha, blobId: "blob-1" });
  return { project: p, blob };
}

function asFile(text: string): File {
  return new File([text], "project.amsproject.json", { type: "application/json" });
}

function contentOnly(p: Project) {
  const copy: Partial<Project> = structuredClone(p);
  delete copy.id;
  delete copy.updatedAt;
  delete copy.changelog;
  return { ...copy, files: p.files.map((f) => ({ ...f, blobId: "" })) };
}

describe("project file", () => {
  it("canonical JSON sorts keys and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, { y: 1, x: 0 }] } })).toBe('{"a":{"c":[2,{"x":0,"y":1}]},"b":1}');
  });

  it("never exports user ids", () => {
    const clean = sanitizeProjectForExport(sampleProject());
    expect(clean.changelog.every((e) => !("author" in e))).toBe(true);
  });

  it("round-trips a project as a new project", async () => {
    const original = sampleProject();
    const blob = await exportProjectFile(original, { embedFiles: false });
    const text = await blob.text();
    const env = JSON.parse(text);
    expect(env.format).toBe(PROJECT_FORMAT);
    expect(env.formatVersion).toBe(1);
    expect(env.checksum.algorithm).toBe("SHA-256");
    expect(env.generator.name).toBe("Asset Model Studio");
    expect(text).not.toContain("user-123");

    const { project, warnings } = await importProjectFile(asFile(text));
    created.push(project.id);
    expect(warnings).toEqual([]);
    expect(project.id).not.toBe(original.id);
    expect(contentOnly(project)).toEqual(contentOnly(sanitizeProjectForExport(original)));
    const stored = await loadProject(project.id);
    expect(stored?.name).toBe(original.name);
    expect(stored?.changelog[stored.changelog.length - 1]?.summary).toMatch(/^Imported from project file/);
  });

  it("detects tampering and allows an explicit override", async () => {
    const blob = await exportProjectFile(sampleProject(), { embedFiles: false });
    const tampered = (await blob.text()).replace('"Pump 1"', '"Pump X"');
    await expect(parseProjectFile(tampered)).rejects.toMatchObject({ code: "checksum-mismatch" });
    const parsed = await parseProjectFile(tampered, { allowChecksumMismatch: true });
    expect(parsed.project.assets.some((a) => a.name === "Pump X")).toBe(true);
    expect(parsed.warnings.join(" ")).toMatch(/checksum does not match/);
  });

  it("migrates a v0 project inside an envelope", async () => {
    const v0 = { id: "old", name: "Legacy", createdAt: "2024-01-01T00:00:00.000Z", updatedAt: "2024-01-01T00:00:00.000Z", assets: [] };
    const env = {
      format: PROJECT_FORMAT,
      formatVersion: 1,
      schemaVersion: 0,
      exportedAt: new Date().toISOString(),
      generator: { name: "Asset Model Studio", version: "0.1.0" },
      checksum: { algorithm: "SHA-256", value: await envelopeChecksum(v0, undefined) },
      project: v0,
    };
    const parsed = await parseProjectFile(JSON.stringify(env));
    expect(parsed.project.schemaVersion).toBe(1);
    expect(parsed.project.assets.some((a) => a.uid === "root")).toBe(true);
    expect(parsed.project.changelog).toEqual([]);
    expect(parsed.warnings.join(" ")).toMatch(/migrated from schema version 0/);
  });

  it("imports a bare project object with a warning", async () => {
    const p = sampleProject();
    const { project, warnings } = await importProjectFile(asFile(JSON.stringify(p)));
    created.push(project.id);
    expect(project.name).toBe(p.name);
    expect(warnings[0]).toMatch(/bare project/);
  });

  it("rejects files that are not projects", async () => {
    await expect(parseProjectFile("not json")).rejects.toBeInstanceOf(ProjectFileError);
    await expect(parseProjectFile('{"hello":1}')).rejects.toMatchObject({ code: "not-a-project" });
    await expect(parseProjectFile(JSON.stringify({ format: PROJECT_FORMAT, formatVersion: 9 }))).rejects.toMatchObject({ code: "unsupported-version" });
  });

  it("embeds, verifies and restores file contents", async () => {
    const { project: p, blob } = await withFile(sampleProject(), "hello asset world");
    const { envelope, missingContents } = await buildProjectEnvelope(p, {
      embedFiles: true,
      loadBlob: async (id) => (id === "blob-1" ? blob : undefined),
    });
    expect(missingContents).toEqual([]);
    expect(envelope.files).toHaveLength(1);
    const text = serializeEnvelope(envelope);

    const { project, warnings } = await importProjectFile(asFile(text));
    created.push(project.id);
    expect(warnings).toEqual([]);
    const file = project.files[0]!;
    expect(file.blobId).not.toBe("blob-1");
    const restored = await getFileBlob(file.blobId);
    expect(await restored?.text()).toBe("hello asset world");
    expect((await db.fileBlobs.get(file.blobId))?.projectId).toBe(project.id);

    // Corrupt the embedded content but keep the envelope checksum consistent.
    const bad = structuredClone(envelope);
    bad.files![0]!.contentBase64 = btoa("tampered content");
    bad.checksum.value = await envelopeChecksum(bad.project, bad.files);
    await expect(parseProjectFile(JSON.stringify(bad))).rejects.toMatchObject({ code: "file-content-mismatch" });
    const lenient = await parseProjectFile(JSON.stringify(bad), { allowChecksumMismatch: true });
    expect(lenient.contents.size).toBe(0);
    expect(lenient.warnings.join(" ")).toMatch(/does not match its checksum/);
  });

  it("warns about file contents that are not embedded", async () => {
    const { project: p } = await withFile(sampleProject(), "x");
    const blob = await exportProjectFile(p, { embedFiles: false });
    const parsed = await parseProjectFile(await blob.text());
    expect(parsed.warnings.join(" ")).toMatch(/1 file\(s\) have no content/);
  });

  it("suggests a slugged, dated file name", () => {
    expect(projectFileName({ name: "Plant A / Line 1" }, new Date(2026, 9, 6))).toBe("plant-a-line-1-2026-10-06.amsproject.json");
  });
});
