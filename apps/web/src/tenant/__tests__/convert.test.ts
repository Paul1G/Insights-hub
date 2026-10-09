import { describe, expect, it } from "vitest";
import { ProjectSchema, ROOT_ASSET_UID } from "@/domain/model";
import { validateProject } from "@/domain/validator";
import { emptyMapping } from "@/deploy/mapping";
import { planDeployment } from "@/deploy/planner";
import { FakeAm } from "@/deploy/__tests__/fakeAm";
import { aspectType, asset, assetType, blobs, deploy, file, indexOf, project, v } from "@/deploy/__tests__/helpers";
import { MemoryBlobStore, aspectTypeBody, assetCreateBody, assetTypeBody, snapshotToProject, variableBody } from "../convert";
import { classifyTypeId, readTenant } from "../read";

async function sha(blob: Blob): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sourceTenant() {
  const metrics = aspectType("Metrics", { variables: [v("power", { unit: "kW", qualityCode: true })] });
  const plate = aspectType("Plate", { category: "static", description: "Nameplate", variables: [v("serial", { dataType: "STRING", length: 40, defaultValue: "n/a" })] });
  const machine = assetType("Machine", {
    instantiable: false,
    variables: [v("since", { dataType: "TIMESTAMP" })],
    aspects: [
      { uid: "m-1", name: "metrics", aspectType: { kind: "project", uid: metrics.uid } },
      { uid: "m-2", name: "plate", aspectType: { kind: "project", uid: plate.uid } },
    ],
  });
  const pump = assetType("Pump", { parent: { kind: "project", uid: machine.uid }, description: "A pump" });
  const content = new Blob(["manual content"], { type: "text/plain" });
  blobs.set("blob-src", content);
  const manual = file("manual.txt", "blob-src", await sha(content), { size: content.size });
  pump.fileAssignments = [{ key: "manual", fileUid: manual.uid }];
  const site = asset("Site", "core.basicsite", ROOT_ASSET_UID, { location: { country: "Austria" } });
  const p1 = asset("P1", pump, site.uid, {
    timezone: "Asia/Kolkata",
    externalId: "EXT-1",
    variables: [{ name: "since", value: "2020-01-01T00:00:00Z" }],
    aspects: [{ name: "plate", variables: [{ name: "serial", value: "SN-1" }] }],
    fileAssignments: [{ key: "doc", fileUid: manual.uid }],
  });
  const sim = asset("Sim", pump, site.uid, { twinType: "simulation", location: { country: "Spain", latitude: 40.4 } });
  const p = project({ aspectTypes: [metrics, plate], assetTypes: [machine, pump], assets: [site, p1, sim], files: [manual] });
  const fake = new FakeAm({ tenant: "src" });
  fake.showDefaults = true;
  const { run } = await deploy(p, fake);
  expect(run.status).toBe("completed");
  return { fake, p };
}

describe("project → request bodies", () => {
  it("builds spec-shaped bodies", () => {
    const dyn = aspectType("Dyn", { variables: [v("x", { defaultValue: "1", qualityCode: true })] });
    expect(aspectTypeBody(dyn)).toEqual({
      name: "Dyn",
      category: "dynamic",
      scope: "private",
      variables: [{ name: "x", dataType: "DOUBLE", searchable: false, qualityCode: true }],
    });
    expect(variableBody(v("s", { dataType: "STRING", length: 12, defaultValue: "a", unit: "u" }), "assetType")).toEqual({
      name: "s",
      dataType: "STRING",
      searchable: false,
      unit: "u",
      length: 12,
      defaultValue: "a",
    });
    const t = assetType("T", { aspects: [{ uid: "x", name: "d", aspectType: { kind: "project", uid: dyn.uid } }] });
    const p = project({ aspectTypes: [dyn], assetTypes: [t] });
    const index = indexOf(p);
    expect(assetTypeBody(t, { tenant: "acme", index })).toEqual({
      name: "T",
      parentTypeId: "core.basicasset",
      instantiable: true,
      scope: "private",
      variables: [],
      aspects: [{ name: "d", aspectTypeId: "acme.Dyn" }],
    });
    const a = asset("A", t, ROOT_ASSET_UID, { aspects: [{ name: "d", variables: [] }] });
    expect(assetCreateBody(a, "acme.T", "root-id", index)).toEqual({ name: "A", typeId: "acme.T", parentId: "root-id", twinType: "performance" });
  });
});

describe("readTenant + snapshotToProject", () => {
  it("reads the tenant and separates core from tenant types", async () => {
    const { fake } = await sourceTenant();
    const phases: string[] = [];
    const snap = await readTenant(fake, { tenant: "src", onProgress: (p) => phases.push(p.phase) });
    expect(phases).toEqual(["root", "aspectTypes", "assetTypes", "assets", "files", "done"]);
    expect(snap.root.assetId).toBe(fake.root.assetId);
    expect(snap.aspectTypes.tenant.map((t) => t.id).sort()).toEqual(["src.Metrics", "src.Plate"]);
    expect(snap.assetTypes.tenant.map((t) => t.id).sort()).toEqual(["src.Machine", "src.Pump"]);
    expect(snap.assetTypes.core.length).toBeGreaterThan(5);
    expect(snap.assets.some((a) => a.assetId === fake.root.assetId)).toBe(false);
    expect(classifyTypeId("other.Shared", "src")).toBe("external");
  });

  it("converts a snapshot into a valid project whose redeploy to the source is a no-op", async () => {
    const { fake } = await sourceTenant();
    const snap = await readTenant(fake, { tenant: "src" });
    const store = new MemoryBlobStore();
    const conv = await snapshotToProject(snap, { name: "Backup", connectionId: "conn-1", includeFileContents: true, transport: fake, blobs: store });
    const p = conv.project;
    expect(ProjectSchema.safeParse(p).success).toBe(true);
    expect(conv.warnings).toEqual([]);
    const pump = p.assetTypes.find((t) => t.name === "Pump")!;
    const machine = p.assetTypes.find((t) => t.name === "Machine")!;
    expect(pump.parent).toEqual({ kind: "project", uid: machine.uid });
    expect(pump.baseline).toEqual({ idSuffix: "Pump", instantiable: true });
    expect(pump.origin).toMatchObject({ source: "tenant", ref: "src.Pump" });
    expect(machine.variables[0]!.baseline).toEqual({ dataType: "TIMESTAMP", searchable: false });
    const plate = p.aspectTypes.find((t) => t.name === "Plate")!;
    expect(plate.baseline).toEqual({ idSuffix: "Plate", name: "Plate", category: "static" });
    expect(plate.variables[0]).toMatchObject({ name: "serial", length: 40, defaultValue: "n/a", baseline: { dataType: "STRING", searchable: false, length: 40 } });
    const site = p.assets.find((a) => a.name === "Site")!;
    expect(site.type).toEqual({ kind: "core", id: "core.basicsite" });
    expect(site.parentUid).toBe(ROOT_ASSET_UID);
    expect(site.location).toEqual({ country: "Austria" });
    const p1 = p.assets.find((a) => a.name === "P1")!;
    expect(p1.timezone).toBe("Asia/Kolkata");
    expect(p1.baseline).toEqual({ twinType: "performance", timezone: "Asia/Kolkata" });
    expect(p1.location).toBeUndefined(); // inherited from Site
    expect(p1.aspects).toEqual([{ name: "plate", variables: [{ name: "serial", value: "SN-1" }] }]);
    const sim = p.assets.find((a) => a.name === "Sim")!;
    expect(sim.twinType).toBe("simulation");
    expect(sim.timezone).toBeUndefined();
    expect(sim.location).toEqual({ country: "Spain", latitude: 40.4 });
    expect(sim.aspects).toEqual([]); // the shown "n/a" is the type default, not an explicit value
    const manual = p.files[0]!;
    expect(manual.size).toBe(14);
    expect(manual.sha256).toBe(await sha(new Blob(["manual content"])));
    expect(store.get(manual.blobId)).toBeDefined();
    expect(p1.fileAssignments).toEqual([{ key: "doc", fileUid: manual.uid }]);
    expect(pump.fileAssignments).toEqual([{ key: "manual", fileUid: manual.uid }]);
    expect(validateProject(indexOf(p)).errors).toBe(0);

    // Redeploying the backup to its source changes nothing.
    const plan = planDeployment(p, indexOf(p), { tenant: "src", snapshot: snap, mapping: conv.mapping }, { mode: "sync" });
    expect(plan.blockers).toEqual([]);
    expect(plan.steps.filter((s) => s.op !== "skip").map((s) => `${s.id} ${JSON.stringify(s.changes)}`)).toEqual([]);
    expect(plan.targetOnly).toEqual([]);
  });

  it("deploys a converted project to another tenant (cross-tenant copy)", async () => {
    const { fake } = await sourceTenant();
    const snap = await readTenant(fake, { tenant: "src" });
    const store = new MemoryBlobStore();
    const conv = await snapshotToProject(snap, { name: "Copy", connectionId: "src-conn", includeFileContents: true, transport: fake, blobs: store });
    for (const [id, blob] of store.blobs) blobs.set(id, blob);
    const target = new FakeAm({ tenant: "dst" });
    const plan = planDeployment(conv.project, indexOf(conv.project), { tenant: "dst", snapshot: await readTenant(target, { tenant: "dst" }), mapping: emptyMapping(conv.project.id, "dst-conn", "dst") }, { mode: "deploy" });
    expect(plan.blockers).toEqual([]);
    const { execute } = await import("@/deploy/__tests__/helpers");
    const { run } = await execute(plan, target);
    expect(run.status).toBe("completed");
    expect(target.assetTypes.get("dst.pump")!.parentTypeId).toBe("dst.Machine");
    expect(target.assetByName("P1")!.timezone).toBe("Asia/Kolkata");
    expect(target.files.size).toBe(1);
  });
});
