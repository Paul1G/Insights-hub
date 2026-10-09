import { describe, expect, it } from "vitest";
import type { AmAspectTypeResource, AmAssetTypeResource } from "@/api/amTypes";
import { BUILTIN_CORE_LIBRARY } from "@/domain/coreLibrary";
import { coreLibraryFromTenant, diffCoreLibraries } from "../coreSync";

const statusAspect: AmAspectTypeResource = {
  id: "core.assetstatus",
  tenantId: "core",
  name: "DeviceAssetStatus",
  category: "static",
  scope: "public",
  description: "Status of a device typed asset.",
  etag: 0,
  variables: [{ name: "health", dataType: "INT", searchable: true, qualityCode: false }],
};

const tenantAspect: AmAspectTypeResource = { ...statusAspect, id: "acme.Vibration", tenantId: "acme", name: "Vibration" };

function assetType(over: Partial<AmAssetTypeResource>): AmAssetTypeResource {
  return {
    id: "core.basicasset",
    tenantId: "core",
    name: "BasicAsset",
    parentTypeId: "",
    instantiable: false,
    scope: "public",
    etag: 0,
    aspects: [],
    variables: [],
    fileAssignments: [],
    ...over,
  };
}

describe("coreLibraryFromTenant", () => {
  const types = [
    assetType({ variables: [{ name: "externalId", dataType: "STRING", length: 255, searchable: true }] }),
    assetType({
      id: "core.basicdevice",
      name: "BasicDevice",
      parentTypeId: "core.basicasset",
      variables: [
        { name: "manufacturer", dataType: "STRING", searchable: true },
        { name: "externalId", dataType: "STRING", searchable: true, _links: { origin: { href: "/assettypes/core.basicasset" } } },
      ],
      aspects: [{ name: "status", aspectType: statusAspect }],
    }),
    assetType({ id: "core.mcfb1500", name: "MindConnectFB1500", parentTypeId: "core.basicagent", instantiable: true }),
    assetType({ id: "acme.Pump", tenantId: "acme", name: "Pump", parentTypeId: "core.basicasset", instantiable: true }),
  ];

  it("keeps core types only and drops inherited members", () => {
    const lib = coreLibraryFromTenant(types, [statusAspect, tenantAspect], { syncedAt: "2026-10-06T00:00:00Z", syncedFrom: "Dev (acme)" });
    expect(lib.source).toBe("tenant");
    expect(lib.syncedFrom).toBe("Dev (acme)");
    expect(lib.assetTypes.map((t) => t.id)).toEqual(["core.basicasset", "core.basicdevice", "core.mcfb1500"]);
    expect(lib.aspectTypes.map((t) => t.id)).toEqual(["core.assetstatus"]);
    const device = lib.assetTypes.find((t) => t.id === "core.basicdevice")!;
    expect(device.variables.map((v) => v.name)).toEqual(["manufacturer"]);
    expect(device.aspects).toEqual([{ name: "status", aspectTypeId: "core.assetstatus" }]);
    expect(lib.assetTypes.find((t) => t.id === "core.basicasset")!.parentTypeId).toBeNull();
  });

  it("takes aspect types embedded in asset types when the list lacks them and keeps documented deprecation", () => {
    const lib = coreLibraryFromTenant(types, [], { syncedAt: "x", syncedFrom: "y" });
    expect(lib.aspectTypes.map((t) => t.id)).toEqual(["core.assetstatus"]);
    expect(lib.assetTypes.find((t) => t.id === "core.mcfb1500")!.deprecated).toBe(true);
  });

  it("normalises variables to the core library shape", () => {
    const lib = coreLibraryFromTenant(types, [statusAspect], { syncedAt: "x", syncedFrom: "y" });
    expect(lib.aspectTypes[0]!.variables[0]).toEqual({
      name: "health",
      dataType: "INT",
      unit: null,
      searchable: true,
      length: null,
      defaultValue: null,
      qualityCode: false,
    });
  });
});

describe("diffCoreLibraries", () => {
  it("is identical for the same library", () => {
    expect(diffCoreLibraries(BUILTIN_CORE_LIBRARY, structuredClone(BUILTIN_CORE_LIBRARY)).identical).toBe(true);
  });

  it("reports added, removed and changed types", () => {
    const next = structuredClone(BUILTIN_CORE_LIBRARY);
    next.assetTypes = next.assetTypes.filter((t) => t.id !== "core.edgedevice");
    next.assetTypes.find((t) => t.id === "core.basicdevice")!.variables.push({
      name: "model",
      dataType: "STRING",
      unit: null,
      searchable: true,
      length: 255,
      defaultValue: null,
    });
    next.aspectTypes.push({ id: "core.newaspect", name: "NewAspect", category: "dynamic", description: "", variables: [] });
    const d = diffCoreLibraries(BUILTIN_CORE_LIBRARY, next);
    expect(d.identical).toBe(false);
    expect(d.assetTypes.removed.map((t) => t.id)).toEqual(["core.edgedevice"]);
    expect(d.assetTypes.changed.map((c) => c.after.id)).toEqual(["core.basicdevice"]);
    expect(d.assetTypes.changed[0]!.changes[0]).toMatchObject({ kind: "added", path: "variables.[name=model]" });
    expect(d.aspectTypes.added.map((t) => t.id)).toEqual(["core.newaspect"]);
    expect(d.assetTypes.unchanged).toBe(BUILTIN_CORE_LIBRARY.assetTypes.length - 2);
  });
});
