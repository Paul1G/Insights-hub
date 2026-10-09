import { describe, expect, it } from "vitest";
import { createEmptyProject, type AspectTypeDef, type AssetTypeDef, type Project, type VariableDef } from "@/domain/model";
import {
  LIBRARY_FORMAT,
  adoptImportedLibrary,
  canonicalJson,
  createUserLibrary,
  exportLibrary,
  insertLibrary,
  libraryClosure,
  libraryIntegrityErrors,
  parseLibraryFile,
} from "../userLibrary";

let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

function variable(name: string, over: Partial<VariableDef> = {}): VariableDef {
  return { uid: id("v"), name, dataType: "DOUBLE", searchable: false, ...over };
}

function aspectType(name: string, over: Partial<AspectTypeDef> = {}): AspectTypeDef {
  return { uid: id("apt"), idSuffix: name, name, category: "dynamic", variables: [variable("value")], ...over };
}

function assetType(name: string, over: Partial<AssetTypeDef> = {}): AssetTypeDef {
  return {
    uid: id("at"),
    idSuffix: name,
    name,
    parent: { kind: "core", id: "core.basicasset" },
    instantiable: true,
    variables: [],
    aspects: [],
    fileAssignments: [],
    ...over,
  };
}

function project(aspectTypes: AspectTypeDef[], assetTypes: AssetTypeDef[]): Project {
  const p = createEmptyProject("Lib test");
  p.aspectTypes = aspectTypes;
  p.assetTypes = assetTypes;
  return p;
}

function sample() {
  const vibration = aspectType("Vibration", {
    baseline: { idSuffix: "Vibration", name: "Vibration", category: "dynamic" },
    variables: [variable("rms", { baseline: { dataType: "DOUBLE", searchable: false } })],
  });
  const nameplate = aspectType("Nameplate", { category: "static" });
  const unused = aspectType("Unused");
  const machine = assetType("Machine", {
    aspects: [{ uid: id("asp"), name: "nameplate", aspectType: { kind: "project", uid: nameplate.uid } }],
    fileAssignments: [{ key: "manual", fileUid: "file-1" }],
    baseline: { idSuffix: "Machine", instantiable: false },
  });
  const pump = assetType("Pump", {
    parent: { kind: "project", uid: machine.uid },
    variables: [variable("serial", { dataType: "STRING", length: 64 })],
    aspects: [
      { uid: id("asp"), name: "vibration", aspectType: { kind: "project", uid: vibration.uid } },
      { uid: id("asp"), name: "status", aspectType: { kind: "core", id: "core.assetstatus" } },
    ],
    origin: { source: "tenant", ref: "acme.Pump" },
  });
  const other = assetType("Other");
  return { p: project([vibration, nameplate, unused], [machine, pump, other]), vibration, nameplate, unused, machine, pump, other };
}

describe("libraryClosure", () => {
  it("pulls in the project parent chain and referenced aspect types", () => {
    const { p, pump, machine, vibration, nameplate, unused, other } = sample();
    const c = libraryClosure(p, { aspectTypeUids: [], assetTypeUids: [pump.uid] });
    expect(c.assetTypes.map((t) => t.uid)).toEqual([machine.uid, pump.uid]);
    expect(c.aspectTypes.map((t) => t.uid).sort()).toEqual([vibration.uid, nameplate.uid].sort());
    expect(c.assetTypes.some((t) => t.uid === other.uid)).toBe(false);
    expect(c.aspectTypes.some((t) => t.uid === unused.uid)).toBe(false);
    expect(c.addedAssetTypes).toEqual(["Machine"]);
    expect(c.addedAspectTypes.sort()).toEqual(["Nameplate", "Vibration"]);
    expect(c.droppedFileAssignments).toBe(1);
  });

  it("strips baselines, origins and file assignments without touching the project", () => {
    const { p, pump, vibration } = sample();
    const c = libraryClosure(p, { aspectTypeUids: [vibration.uid], assetTypeUids: [pump.uid] });
    for (const t of c.assetTypes) {
      expect(t.baseline).toBeUndefined();
      expect(t.origin).toBeUndefined();
      expect(t.fileAssignments).toEqual([]);
    }
    const v = c.aspectTypes.find((t) => t.uid === vibration.uid)!;
    expect(v.baseline).toBeUndefined();
    expect(v.variables[0]!.baseline).toBeUndefined();
    // Source untouched.
    expect(p.aspectTypes[0]!.baseline).toBeDefined();
    expect(p.assetTypes[0]!.fileAssignments).toHaveLength(1);
  });

  it("is cycle-safe on broken parent chains", () => {
    const a = assetType("A");
    const b = assetType("B", { parent: { kind: "project", uid: a.uid } });
    a.parent = { kind: "project", uid: b.uid };
    const c = libraryClosure(project([], [a, b]), { aspectTypeUids: [], assetTypeUids: [a.uid] });
    expect(c.assetTypes).toHaveLength(2);
  });
});

describe("insertLibrary", () => {
  it("copies with fresh uids and remaps library-internal references", () => {
    const { p, pump } = sample();
    const lib = createUserLibrary("Rotating", undefined, libraryClosure(p, { aspectTypeUids: [], assetTypeUids: [pump.uid] }));
    const target = createEmptyProject("Target");
    const report = insertLibrary(target, lib, "2026-01-01T00:00:00.000Z");

    expect(target.assetTypes).toHaveLength(2);
    expect(target.aspectTypes).toHaveLength(2);
    const libUids = new Set([...lib.assetTypes, ...lib.aspectTypes].map((t) => t.uid));
    for (const t of [...target.assetTypes, ...target.aspectTypes]) expect(libUids.has(t.uid)).toBe(false);

    const newMachine = target.assetTypes.find((t) => t.name === "Machine")!;
    const newPump = target.assetTypes.find((t) => t.name === "Pump")!;
    expect(newPump.parent).toEqual({ kind: "project", uid: newMachine.uid });
    const vib = newPump.aspects.find((a) => a.name === "vibration")!;
    const newVibration = target.aspectTypes.find((t) => t.name === "Vibration")!;
    expect(vib.aspectType).toEqual({ kind: "project", uid: newVibration.uid });
    expect(newPump.aspects.find((a) => a.name === "status")!.aspectType).toEqual({ kind: "core", id: "core.assetstatus" });
    // Fresh member uids.
    expect(newPump.variables[0]!.uid).not.toBe(lib.assetTypes.find((t) => t.name === "Pump")!.variables[0]!.uid);
    expect(newPump.origin).toEqual({ source: "library", ref: "Rotating", at: "2026-01-01T00:00:00.000Z" });
    expect(report.renames).toEqual([]);
    expect(report.assetTypes.map((t) => t.name).sort()).toEqual(["Machine", "Pump"]);
  });

  it("resolves name and id conflicts case-insensitively and reports renames", () => {
    const { p, pump } = sample();
    const lib = createUserLibrary("Rotating", undefined, libraryClosure(p, { aspectTypeUids: [], assetTypeUids: [pump.uid] }));
    const target = createEmptyProject("Target");
    target.assetTypes.push(assetType("pump", { idSuffix: "PUMP" }));
    target.aspectTypes.push(aspectType("vibration", { idSuffix: "Vibration_x" }), aspectType("Other", { idSuffix: "vibration" }));

    const report = insertLibrary(target, lib);
    const pumpCopy = target.assetTypes.find((t) => t.name === "Pump_2")!;
    expect(pumpCopy).toBeDefined();
    expect(pumpCopy.idSuffix).toBe("Pump_2");
    const vib = target.aspectTypes.find((t) => t.name === "Vibration_2")!;
    expect(vib.idSuffix).toBe("Vibration_2");
    expect(report.renames).toEqual(
      expect.arrayContaining([
        { kind: "assetType", field: "name", from: "Pump", to: "Pump_2" },
        { kind: "assetType", field: "idSuffix", from: "Pump", to: "Pump_2" },
        { kind: "aspectType", field: "name", from: "Vibration", to: "Vibration_2" },
        { kind: "aspectType", field: "idSuffix", from: "Vibration", to: "Vibration_2" },
      ]),
    );
    expect(report.renames).toHaveLength(4);
  });

  it("inserting the same library twice never collides", () => {
    const { p, pump } = sample();
    const lib = createUserLibrary("Rotating", undefined, libraryClosure(p, { aspectTypeUids: [], assetTypeUids: [pump.uid] }));
    const target = createEmptyProject("Target");
    insertLibrary(target, lib);
    insertLibrary(target, lib);
    const names = target.assetTypes.map((t) => t.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    const second = target.assetTypes.find((t) => t.name === "Pump_2")!;
    expect(second.parent).toEqual({ kind: "project", uid: target.assetTypes.find((t) => t.name === "Machine_2")!.uid });
  });

  it("rejects libraries with dangling references", () => {
    const orphan = assetType("Orphan", { parent: { kind: "project", uid: "missing" } });
    const lib = { name: "Broken", aspectTypes: [], assetTypes: [orphan] };
    expect(libraryIntegrityErrors(lib)).toHaveLength(1);
    expect(() => insertLibrary(createEmptyProject("T"), lib)).toThrow(/inconsistent/);
  });
});

describe("export / import", () => {
  it("canonical JSON sorts keys and drops undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: undefined }], c: "x" } })).toBe('{"a":{"c":"x","d":[1,{"z":1}]},"b":1}');
  });

  it("round-trips with a valid checksum", async () => {
    const { p, pump } = sample();
    const lib = createUserLibrary("Rotating", "Pumps and motors", libraryClosure(p, { aspectTypeUids: [], assetTypeUids: [pump.uid] }));
    const file = await exportLibrary(lib);
    expect(file.format).toBe(LIBRARY_FORMAT);
    expect(file.checksum.value).toMatch(/^[0-9a-f]{64}$/);
    const parsed = await parseLibraryFile(JSON.stringify(file, null, 2));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.checksumValid).toBe(true);
    expect(parsed.library.assetTypes).toHaveLength(2);
    // Key order in the file does not matter (canonical JSON).
    const { assetTypes, ...rest } = file.library;
    const reordered = { ...file, library: { assetTypes, ...rest } };
    const again = await parseLibraryFile(JSON.stringify(reordered));
    expect(again.ok && again.checksumValid).toBe(true);
  });

  it("detects tampering", async () => {
    const { p, pump } = sample();
    const lib = createUserLibrary("Rotating", undefined, libraryClosure(p, { aspectTypeUids: [], assetTypeUids: [pump.uid] }));
    const file = await exportLibrary(lib);
    const tampered = structuredClone(file);
    tampered.library.assetTypes[1]!.name = "Hacked";
    const parsed = await parseLibraryFile(JSON.stringify(tampered));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.checksumValid).toBe(false);
    expect(parsed.actualChecksum).not.toBe(parsed.expectedChecksum);
  });

  it("rejects foreign, malformed and inconsistent files", async () => {
    expect(await parseLibraryFile("not json")).toMatchObject({ ok: false });
    const foreign = await parseLibraryFile(JSON.stringify({ format: "something/else" }));
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.errors[0]).toMatch(/Not an Asset Model Studio library/);

    const { p, pump } = sample();
    const lib = createUserLibrary("Rotating", undefined, libraryClosure(p, { aspectTypeUids: [], assetTypeUids: [pump.uid] }));
    const file = await exportLibrary(lib);
    const broken = structuredClone(file) as unknown as { library: { assetTypes: { instantiable: unknown }[] } };
    broken.library.assetTypes[0]!.instantiable = "yes";
    expect((await parseLibraryFile(JSON.stringify(broken))).ok).toBe(false);

    const dangling = structuredClone(file);
    dangling.library.aspectTypes = [];
    const res = await parseLibraryFile(JSON.stringify(dangling));
    expect(res.ok).toBe(false);
  });

  it("adopts imports under a new id and a unique name", () => {
    const lib = createUserLibrary("Rotating", undefined, { aspectTypes: [], assetTypes: [], addedAspectTypes: [], addedAssetTypes: [], droppedFileAssignments: 0 });
    const adopted = adoptImportedLibrary(lib, ["rotating"]);
    expect(adopted.id).not.toBe(lib.id);
    expect(adopted.name).toBe("Rotating 2");
  });
});
