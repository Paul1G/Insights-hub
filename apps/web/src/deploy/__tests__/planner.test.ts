import { describe, expect, it } from "vitest";
import { ROOT_ASSET_UID } from "@/domain/model";
import { PHASES } from "../types";
import { FakeAm } from "./fakeAm";
import { analyze, aspectType, asset, assetType, blobs, deploy, execute, file, project, stepOf, v } from "./helpers";

const last = <T,>(list: T[]): T => list[list.length - 1]!;

function sampleProject() {
  const metrics = aspectType("Metrics", { variables: [v("power", { unit: "kW" }), v("speed")] });
  const nameplate = aspectType("Nameplate", { category: "static", variables: [v("serial", { dataType: "STRING", length: 64 })] });
  const base = assetType("Machine", {
    variables: [v("installed", { dataType: "TIMESTAMP" })],
    aspects: [
      { uid: "asp-1", name: "metrics", aspectType: { kind: "project", uid: metrics.uid } },
      { uid: "asp-2", name: "nameplate", aspectType: { kind: "project", uid: nameplate.uid } },
    ],
    instantiable: false,
  });
  const pump = assetType("Pump", { parent: { kind: "project", uid: base.uid }, variables: [v("rpmMax", { dataType: "INT" })] });
  blobs.set("blob-manual", new Blob(["hello"], { type: "text/plain" }));
  const manual = file("manual.txt", "blob-manual", "sha-manual");
  pump.fileAssignments = [{ key: "manual", fileUid: manual.uid }];
  const site = asset("Plant", "core.basicsite", ROOT_ASSET_UID, { location: { country: "Austria", locality: "Linz" } });
  const p1 = asset("P-001", pump, site.uid, {
    variables: [{ name: "rpmMax", value: "3000" }],
    aspects: [{ name: "nameplate", variables: [{ name: "serial", value: "SN1" }] }],
  });
  const p2 = asset("P-002", pump, site.uid, { timezone: "Europe/Vienna" });
  return { p: project({ aspectTypes: [metrics, nameplate], assetTypes: [pump, base], assets: [site, p1, p2], files: [manual] }), metrics, nameplate, base, pump, site, p1, p2, manual };
}

describe("planDeployment", () => {
  it("orders phases, asset types topologically and assets by hierarchy level", async () => {
    const s = sampleProject();
    const fake = new FakeAm();
    const plan = await analyze(s.p, fake);
    expect(plan.blockers).toEqual([]);
    const phaseOrder = plan.steps.map((x) => PHASES.indexOf(x.phase));
    expect([...phaseOrder].sort((a, b) => a - b)).toEqual(phaseOrder);

    const base = stepOf(plan, `assetTypes:${s.base.uid}`);
    const pump = stepOf(plan, `assetTypes:${s.pump.uid}`);
    expect(base.level).toBe(0);
    expect(pump.level).toBe(1);
    expect(plan.steps.indexOf(base)).toBeLessThan(plan.steps.indexOf(pump));
    expect(pump.dependsOn).toContain(base.id);
    expect(base.dependsOn).toEqual(expect.arrayContaining([`aspectTypes:${s.metrics.uid}`, `aspectTypes:${s.nameplate.uid}`]));

    const site = stepOf(plan, `assets:${s.site.uid}`);
    const p1 = stepOf(plan, `assets:${s.p1.uid}`);
    expect(site.level).toBe(2);
    expect(p1.level).toBe(3);
    expect(p1.dependsOn).toEqual(expect.arrayContaining([site.id, pump.id]));
    expect(p1.tenantId).toBe("pending");
    const body = p1.requests[0]!.body as { parentId: string; typeId: string; aspects: unknown[] };
    expect(body.parentId).toBe(`{{asset:${s.site.uid}}}`);
    expect(body.typeId).toBe("acme.Pump");
    expect(body.aspects).toEqual([{ name: "nameplate", variables: [{ name: "serial", value: "SN1" }] }]);
    expect((stepOf(plan, `assets:${s.p2.uid}`).requests[0]!.body as { timezone?: string }).timezone).toBe("Europe/Vienna");
    expect((p1.requests[0]!.body as { timezone?: string }).timezone).toBeUndefined();

    const at = stepOf(plan, `aspectTypes:${s.metrics.uid}`);
    expect(at.requests[0]).toMatchObject({ method: "PUT", path: "/aspecttypes/acme.Metrics", ifNoneMatch: "*" });
    const upload = stepOf(plan, `files:${s.manual.uid}`);
    expect(upload.op).toBe("upload");
    const assign = stepOf(plan, `fileAssignments:assetType:${s.pump.uid}`);
    expect(assign.dependsOn).toEqual(expect.arrayContaining([pump.id, upload.id]));
    expect(assign.requests[0]).toMatchObject({ method: "PUT", path: "/assettypes/acme.Pump/fileAssignments/manual", body: { fileId: `{{file:${s.manual.uid}}}` } });
    expect(plan.summary.create).toBe(8);
  });

  it("is idempotent: a redeploy with the mapping only updates or skips", async () => {
    const s = sampleProject();
    const fake = new FakeAm();
    const first = await deploy(s.p, fake);
    expect(first.run.status).toBe("completed");
    const again = await analyze(s.p, fake, first.mapping);
    expect(again.steps.filter((x) => x.op === "create" || x.op === "upload")).toEqual([]);
    expect(again.steps.filter((x) => x.op !== "skip").map((x) => x.id)).toEqual([]);
    expect(again.targetOnly).toEqual([]);

    // Without a mapping natural keys still match (files by name are replaced, since content is unknown).
    const natural = await analyze(s.p, fake);
    expect(natural.steps.filter((x) => x.op === "create")).toEqual([]);
    expect(natural.steps.filter((x) => x.op !== "skip").map((x) => x.entity.kind)).toEqual(["file"]);
  });

  it("splits swapped and cyclic variable renames into sequential requests and executes them", async () => {
    const s = sampleProject();
    const fake = new FakeAm();
    const first = await deploy(s.p, fake);
    // swap power <-> speed on the aspect type, rename + unit on the asset type
    const [power, speed] = s.metrics.variables;
    power!.name = "speed";
    speed!.name = "power";
    s.pump.variables[0]!.name = "rpmLimit";
    s.pump.variables[0]!.unit = "1/min";
    s.p1.variables = [{ name: "rpmLimit", value: "3000" }];
    const plan = await analyze(s.p, fake, first.mapping);
    const at = stepOf(plan, `aspectTypes:${s.metrics.uid}`);
    expect(at.op).toBe("update");
    expect(at.requests.length).toBe(3);
    expect(at.requests.every((r) => r.method === "PATCH" && r.path === "/aspecttypes/acme.Metrics/variables")).toBe(true);
    const pump = stepOf(plan, `assetTypes:${s.pump.uid}`);
    expect(pump.requests).toHaveLength(1);
    expect(pump.requests[0]).toMatchObject({ path: "/assettypes/acme.Pump/variables", body: { rpmMax: { name: "rpmLimit", unit: "1/min" } }, contentType: "application/merge-patch+json" });

    const second = await execute(plan, fake, first.mapping);
    expect(second.run.status).toBe("completed");
    const names = fake.aspectTypes.get("acme.metrics")!.variables.map((x) => [x.name, x.unit]);
    expect(names).toEqual(expect.arrayContaining([["speed", "kW"], ["power", undefined]]));
    expect(fake.assetTypes.get("acme.pump")!.variables[0]).toMatchObject({ name: "rpmLimit", unit: "1/min" });
    // Mapping follows the renames, so the next plan is clean.
    const third = await analyze(s.p, fake, second.mapping);
    expect(third.steps.filter((x) => x.op !== "skip")).toEqual([]);
  });

  it("blocks immutable conflicts with the documented reason", async () => {
    const s = sampleProject();
    const fake = new FakeAm();
    const first = await deploy(s.p, fake);
    s.metrics.category = "static";
    s.nameplate.variables[0]!.length = 32; // decrease
    s.pump.variables[0]!.dataType = "LONG";
    s.base.instantiable = true; // false -> true is allowed
    s.p1.twinType = "simulation";
    s.p2.timezone = "Europe/Berlin";
    const plan = await analyze(s.p, fake, first.mapping);
    const codes = plan.blockers.filter((b) => b.kind === "conflict").map((b) => b.code);
    expect(codes).toEqual(expect.arrayContaining(["ASPECT_TYPE_CATEGORY_IMMUTABLE", "VAR_LENGTH_DECREASE", "VAR_DATATYPE_IMMUTABLE", "TWIN_TYPE_IMMUTABLE", "TIMEZONE_IMMUTABLE"]));
    expect(stepOf(plan, `assetTypes:${s.pump.uid}`).blocked?.hint).toMatch(/recreate/i);
    // Machine itself may become instantiable (false → true), but it uses the blocked aspect type.
    expect(stepOf(plan, `assetTypes:${s.base.uid}`).blocked?.code).toBe("DEPENDENCY_BLOCKED");
    expect(last(stepOf(plan, `assetTypes:${s.base.uid}`).requests).body).toMatchObject({ instantiable: true });

    s.base.instantiable = false;
    fake.assetTypes.get("acme.machine")!.instantiable = true;
    const plan2 = await analyze(s.p, fake, first.mapping);
    expect(stepOf(plan2, `assetTypes:${s.base.uid}`).blocked?.code).toBe("INSTANTIABLE_IMMUTABLE");
  });

  it("deletes only mapped-but-removed objects in sync mode and reports target-only objects", async () => {
    const s = sampleProject();
    const fake = new FakeAm();
    const first = await deploy(s.p, fake);
    // Someone else created an asset in the tenant.
    await fake.request({ method: "POST", path: "/assets", body: { name: "Foreign", typeId: "core.basicarea", parentId: fake.root.assetId } });
    // Remove P-002 from the project.
    s.p.assets = s.p.assets.filter((a) => a.uid !== s.p2.uid);

    const deployPlan = await analyze(s.p, fake, first.mapping, "deploy");
    expect(deployPlan.steps.filter((x) => x.op === "delete")).toEqual([]);
    expect(deployPlan.removedFromProject.map((x) => x.label)).toEqual(["P-002"]);
    expect(deployPlan.targetOnly.map((x) => x.label)).toEqual(["Foreign"]);

    const sync = await analyze(s.p, fake, first.mapping, "sync");
    const deletes = sync.steps.filter((x) => x.op === "delete");
    expect(deletes.map((x) => x.entity.label)).toEqual(["P-002"]);
    expect(deletes[0]!.phase).toBe("deletions");
    expect(deletes[0]!.destructive).toBe(true);
    expect(sync.targetOnly.map((x) => x.label)).toEqual(["Foreign"]);
    const result = await execute(sync, fake, first.mapping);
    expect(result.run.status).toBe("completed");
    expect(fake.assetByName("P-002")).toBeUndefined();
    expect(fake.assetByName("Foreign")).toBeDefined();
    expect(Object.values(result.mapping.entries).some((e) => e.name === "P-002")).toBe(false);
  });

  it("never deletes the root and orders deletions children first", async () => {
    const t = assetType("Box");
    const parent = asset("Parent", t);
    const child = asset("Child", t, parent.uid);
    const p = project({ assetTypes: [t], assets: [parent, child] });
    const fake = new FakeAm();
    const first = await deploy(p, fake);
    p.assets = p.assets.filter((a) => a.uid === ROOT_ASSET_UID);
    p.assetTypes = [];
    const sync = await analyze(p, fake, first.mapping, "sync");
    const ids = sync.steps.filter((x) => x.op === "delete").map((x) => x.entity.label);
    expect(ids).toEqual(["Child", "Parent", "Box"]);
    expect(stepOf(sync, `deletions:asset:${parent.uid}`).dependsOn).toContain(`deletions:asset:${child.uid}`);
    expect(stepOf(sync, `deletions:assetType:${t.uid}`).dependsOn).toEqual(expect.arrayContaining([`deletions:asset:${child.uid}`, `deletions:asset:${parent.uid}`]));
    const result = await execute(sync, fake, first.mapping);
    expect(result.run.status).toBe("completed");
    expect(fake.assets.size).toBe(0);
    expect(fake.assetTypes.has("acme.box")).toBe(false);
  });

  it("blocks missing core / external references and validation errors gate execution", async () => {
    const ext = assetType("Ext", { parent: { kind: "external", id: "other.Shared" } });
    const p = project({ assetTypes: [ext], assets: [asset("", ext)] });
    const plan = await analyze(p, new FakeAm());
    expect(plan.blockers.some((b) => b.kind === "reference" && b.message.includes("other.Shared"))).toBe(true);
    expect(stepOf(plan, `assetTypes:${ext.uid}`).blocked?.code).toBe("REFERENCE_MISSING");
    expect(plan.blockers.some((b) => b.kind === "validation")).toBe(true);
  });

  it("matches assets by parent and name and detects moves", async () => {
    const s = sampleProject();
    const fake = new FakeAm();
    const first = await deploy(s.p, fake);
    const hall = asset("Hall", "core.basicarea");
    s.p.assets.push(hall);
    s.p2.parentUid = hall.uid;
    const plan = await analyze(s.p, fake, first.mapping);
    const move = stepOf(plan, `assets:move:${s.p2.uid}`);
    expect(move.op).toBe("move");
    expect(move.dependsOn).toEqual([`assets:${hall.uid}`]);
    expect(move.requests[0]).toMatchObject({ method: "POST", body: { newParentId: `{{asset:${hall.uid}}}` } });
    const result = await execute(plan, fake, first.mapping);
    expect(result.run.status).toBe("completed");
    expect(fake.assetByName("P-002")!.parentId).toBe(fake.assetByName("Hall")!.assetId);
  });

  it("plans location changes for existing assets via the location endpoint", async () => {
    const s = sampleProject();
    const fake = new FakeAm();
    const first = await deploy(s.p, fake);
    s.site.location = { country: "Germany" };
    s.p1.location = { country: "Spain" };
    const plan = await analyze(s.p, fake, first.mapping);
    expect(stepOf(plan, `locations:${s.site.uid}`).requests[0]).toMatchObject({ method: "PUT", path: expect.stringContaining("/location"), body: { country: "Germany" } });
    expect(stepOf(plan, `locations:${s.p1.uid}`).requests[0]).toMatchObject({ method: "PUT", body: { country: "Spain" } });
    const result = await execute(plan, fake, first.mapping);
    expect(result.run.status).toBe("completed");
    s.p1.location = undefined;
    const plan2 = await analyze(s.p, fake, result.mapping);
    expect(stepOf(plan2, `locations:${s.p1.uid}`).requests[0]!.method).toBe("DELETE");
  });

  it("adds and removes asset type variables and aspects with complete arrays", async () => {
    const s = sampleProject();
    const fake = new FakeAm();
    const first = await deploy(s.p, fake);
    s.pump.variables.push(v("flow"));
    s.base.aspects = s.base.aspects.filter((a) => a.name !== "nameplate");
    s.p1.aspects = [];
    s.base.aspects[0]!.name = "telemetry";
    const plan = await analyze(s.p, fake, first.mapping);
    const pump = stepOf(plan, `assetTypes:${s.pump.uid}`);
    expect(last(pump.requests).body).toMatchObject({ variables: [{ name: "rpmMax" }, { name: "flow" }] });
    const base = stepOf(plan, `assetTypes:${s.base.uid}`);
    const patch = last(base.requests).body as { aspects: { name: string; aspectId?: string }[]; variables: unknown[] };
    expect(patch.aspects).toHaveLength(1);
    expect(patch.aspects[0]!.name).toBe("telemetry");
    expect(patch.aspects[0]!.aspectId).toBeTruthy();
    expect(patch.variables).toHaveLength(1);
    expect(base.destructive).toBe(true);
    const result = await execute(plan, fake, first.mapping);
    expect(result.run.status).toBe("completed");
    expect(fake.assetTypes.get("acme.machine")!.aspects.map((a) => a.name)).toEqual(["telemetry"]);
  });

  it("keeps members that exist only in the target and their asset values", async () => {
    const s = sampleProject();
    const fake = new FakeAm();
    const first = await deploy(s.p, fake);
    // Someone adds a variable to the deployed type and sets a value on an asset.
    const pump = fake.assetTypes.get("acme.pump")!;
    pump.variables.push({ name: "foreign", dataType: "STRING", searchable: false, length: 20 });
    pump.etag++;
    const p1 = fake.assetByName("P-001")!;
    p1.variables.push({ name: "foreign", value: "kept" });
    p1.etag++;
    s.pump.variables.push(v("added"));
    const plan = await analyze(s.p, fake, first.mapping);
    const step = stepOf(plan, `assetTypes:${s.pump.uid}`);
    expect((last(step.requests).body as { variables: { name: string }[] }).variables.map((x) => x.name)).toEqual(["rpmMax", "added", "foreign"]);
    expect(plan.notes.some((n) => n.includes('"foreign"'))).toBe(true);
    expect(stepOf(plan, `assets:${s.p1.uid}`).op).toBe("skip");
    const result = await execute(plan, fake, first.mapping);
    expect(result.run.status).toBe("completed");
    expect(fake.assetByName("P-001")!.variables.find((x) => x.name === "foreign")?.value).toBe("kept");
  });

  it("never pins type defaults when the tenant shows effective values", async () => {
    const t = assetType("Valve", { variables: [v("size", { dataType: "STRING", length: 10, defaultValue: "DN50" }), v("tag", { dataType: "STRING" })] });
    const a = asset("V1", t);
    const p = project({ assetTypes: [t], assets: [a] });
    const fake = new FakeAm();
    fake.showDefaults = true;
    const first = await deploy(p, fake);
    expect((await analyze(p, fake, first.mapping)).steps.filter((x) => x.op !== "skip")).toEqual([]);
    a.variables = [{ name: "tag", value: "T-1" }];
    const plan = await analyze(p, fake, first.mapping);
    expect(stepOf(plan, `assets:${a.uid}`).requests[0]!.body).toEqual({ variables: [{ name: "tag", value: "T-1" }] });
    await execute(plan, fake, first.mapping);
    // Changing the default follows through without touching the asset.
    t.variables[0]!.defaultValue = "DN80";
    const plan2 = await analyze(p, fake, first.mapping);
    expect(stepOf(plan2, `assets:${a.uid}`).op).toBe("skip");
    const r2 = await execute(plan2, fake, first.mapping);
    expect(r2.run.status).toBe("completed");
    expect((await analyze(p, fake, first.mapping)).steps.filter((x) => x.op !== "skip")).toEqual([]);
  });
});
