import { describe, expect, it } from "vitest";
import { BUILTIN_CORE_LIBRARY } from "@/domain/coreLibrary";
import { ROOT_ASSET_UID, type Project } from "@/domain/model";
import { ModelIndex } from "@/domain/resolve";
import { validateProject } from "@/domain/validator";
import { FakeAm } from "@/deploy/__tests__/fakeAm";
import { analyze, aspectType, asset, assetType, deploy, project, v } from "@/deploy/__tests__/helpers";
import { emptyMapping } from "@/deploy/mapping";
import { readTenant, type TenantSnapshot } from "@/tenant/read";
import { externalTypesFromSnapshot } from "../catalog";
import { applyImport, correspondence, mergedMapping, planImport, selectEverything, type ImportSelection } from "../importToProject";

/** A tenant with Machine (abstract) ← Pump, a Metrics aspect type and Site → P1, P2 → Sub. */
async function existingTenant() {
  const metrics = aspectType("Metrics", { variables: [v("power"), v("speed")] });
  const machine = assetType("Machine", {
    instantiable: false,
    variables: [v("serial", { dataType: "STRING" })],
    aspects: [{ uid: "asp", name: "metrics", aspectType: { kind: "project", uid: metrics.uid } }],
  });
  const pump = assetType("Pump", { parent: { kind: "project", uid: machine.uid } });
  const site = asset("Site", "core.basicsite");
  const p1 = asset("P1", pump, site.uid, { variables: [{ name: "serial", value: "S-1" }] });
  const p2 = asset("P2", pump, site.uid);
  const sub = asset("Sub", "core.basicarea", p2.uid);
  const fake = new FakeAm({ tenant: "acme" });
  const { run } = await deploy(project({ aspectTypes: [metrics], assetTypes: [machine, pump], assets: [site, p1, p2, sub] }), fake);
  expect(run.status).toBe("completed");
  const snapshot = await readTenant(fake, { tenant: "acme", includeFiles: false });
  return { fake, snapshot };
}

const idOf = (snapshot: TenantSnapshot, name: string) => snapshot.assets.find((a) => a.name === name)!.assetId;

const none: ImportSelection = { aspectTypeIds: [], assetTypeIds: [], assetIds: [], includeSubtrees: false, includeAssetTypes: true };

async function importInto(p: Project, snapshot: TenantSnapshot, selection: ImportSelection) {
  const plan = await planImport(p, snapshot, undefined, selection, "conn-1");
  applyImport(p, plan);
  return plan;
}

describe("import existing tenant objects into a project", () => {
  it("pulls in ancestors, the type chain and aspect types with baselines", async () => {
    const { snapshot } = await existingTenant();
    const p = project();
    const plan = await importInto(p, snapshot, { ...none, assetIds: [idOf(snapshot, "P1")] });
    expect(plan.assets.map((a) => a.name).sort()).toEqual(["P1", "Site"]);
    expect(plan.assetTypes.map((t) => t.name).sort()).toEqual(["Machine", "Pump"]);
    expect(plan.aspectTypes.map((t) => t.name)).toEqual(["Metrics"]);

    const site = p.assets.find((a) => a.name === "Site")!;
    const p1 = p.assets.find((a) => a.name === "P1")!;
    const pump = p.assetTypes.find((t) => t.name === "Pump")!;
    const machine = p.assetTypes.find((t) => t.name === "Machine")!;
    expect(site.parentUid).toBe(ROOT_ASSET_UID);
    expect(p1.parentUid).toBe(site.uid);
    expect(p1.type).toEqual({ kind: "project", uid: pump.uid });
    expect(pump.parent).toEqual({ kind: "project", uid: machine.uid });
    expect(machine.variables[0]!.baseline).toMatchObject({ dataType: "STRING" });
    expect(Object.values(plan.mappingEntries).every((e) => e.imported)).toBe(true);
    expect(validateProject(new ModelIndex(p, BUILTIN_CORE_LIBRARY)).errors).toBe(0);
  });

  it("imports whole subtrees", async () => {
    const { snapshot } = await existingTenant();
    const plan = await planImport(project(), snapshot, undefined, { ...none, assetIds: [idOf(snapshot, "Site")], includeSubtrees: true }, "c");
    expect(plan.assets.map((a) => a.name).sort()).toEqual(["P1", "P2", "Site", "Sub"]);
  });

  it("reuses what the project already contains (natural keys)", async () => {
    const { snapshot } = await existingTenant();
    const machine = assetType("Machine", { instantiable: false, variables: [v("serial", { dataType: "STRING" })] });
    const site = asset("site", "core.basicsite");
    const p = project({ assetTypes: [machine], assets: [site] });
    const match = correspondence(p, snapshot, undefined);
    expect(match.assets.get(idOf(snapshot, "Site"))).toBe(site.uid);

    const plan = await importInto(p, snapshot, { ...none, assetIds: [idOf(snapshot, "P1")] });
    expect(plan.assets.map((a) => a.name)).toEqual(["P1"]);
    expect(plan.items.find((i) => i.name === "Site")?.status).toBe("in-project");
    expect(p.assets.find((a) => a.name === "P1")!.parentUid).toBe(site.uid);
    const pump = p.assetTypes.find((t) => t.name === "Pump")!;
    expect(pump.parent).toEqual({ kind: "project", uid: machine.uid });
    expect(p.assetTypes.filter((t) => t.name === "Machine")).toHaveLength(1);
  });

  it("can reference existing types instead of importing them", async () => {
    const { snapshot } = await existingTenant();
    const plan = await planImport(project(), snapshot, undefined, { ...none, assetIds: [idOf(snapshot, "P1")], includeAssetTypes: false }, "c");
    expect(plan.assetTypes).toEqual([]);
    expect(plan.assets.find((a) => a.name === "P1")!.type).toEqual({ kind: "external", id: "acme.Pump" });
  });

  it("deploys an imported model idempotently and never deletes imported objects in sync mode", async () => {
    const { fake, snapshot } = await existingTenant();
    const p = project();
    const plan = await planImport(p, snapshot, undefined, selectEverything(snapshot), "conn-1");
    applyImport(p, plan);
    const mapping = mergedMapping(emptyMapping(p.id, "conn-1", "acme"), plan, p.id, "conn-1", "acme");

    const redeploy = await analyze(p, fake, mapping);
    expect(redeploy.summary.create).toBe(0);
    expect(redeploy.summary.update).toBe(0);

    p.assets = p.assets.filter((a) => a.name !== "Sub");
    const sync = await analyze(p, fake, mapping, "sync");
    expect(sync.summary.delete).toBe(0);
  });
});

describe("tenant catalog → existing types", () => {
  it("resolves external references with the tenant's definitions", async () => {
    const { snapshot } = await existingTenant();
    const external = externalTypesFromSnapshot(snapshot, "Fake tenant");
    expect(external.assetType("ACME.pump")?.parentTypeId).toBe("acme.Machine");

    const tank = assetType("Tank", { parent: { kind: "external", id: "acme.Machine" }, variables: [v("level")] });
    const p = project({ assetTypes: [tank], assets: [asset("T1", tank), asset("P9", "core.basicsite")] });
    const ix = new ModelIndex(p, BUILTIN_CORE_LIBRARY, external);
    const resolved = ix.resolveAssetType({ kind: "project", uid: tank.uid })!;
    expect(resolved.incomplete).toBe(false);
    // own level + inherited serial + Metrics (2 variables)
    expect(resolved.billableAttributes).toBe(4);
    expect(resolved.depth).toBe(2);
    expect(ix.externalAssetTypes().map((t) => t.id).sort()).toEqual(["acme.Machine", "acme.Pump"]);

    const issues = validateProject(ix).issues.map((i) => i.code);
    expect(issues).not.toContain("PARENT_EXTERNAL");
  });

  it("warns when a new project type reuses the id of an existing tenant type", async () => {
    const { snapshot } = await existingTenant();
    const external = externalTypesFromSnapshot(snapshot, "Fake tenant");
    const p = project({ assetTypes: [assetType("Pump")] });
    const ix = new ModelIndex(p, BUILTIN_CORE_LIBRARY, external);
    expect(validateProject(ix).issues.map((i) => i.code)).toContain("EXISTS_IN_TENANT");
    expect(ix.externalAssetTypes().map((t) => t.id)).toEqual(["acme.Machine"]);
  });
});
