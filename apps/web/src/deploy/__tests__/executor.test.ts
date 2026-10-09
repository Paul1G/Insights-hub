import { describe, expect, it } from "vitest";
import type { AmRequest } from "@/api/client";
import { BUILTIN_CORE_LIBRARY } from "@/domain/coreLibrary";
import { ModelIndex } from "@/domain/resolve";
import { applyRunBaselines } from "../baselines";
import { RunController, createRun, executeRun, prepareRetry } from "../executor";
import { emptyMapping } from "../mapping";
import { executionGate } from "../planner";
import { buildReport, reportToMarkdown } from "../report";
import { rollbackRun, startRun } from "../run";
import { MemoryPersistence } from "../store";
import { FakeAm } from "./fakeAm";
import { analyze, aspectType, asset, assetType, deploy, execute, project, statusOf, stepOf, v } from "./helpers";

function hierarchy(n = 6) {
  const t = assetType("Unit", { variables: [v("serial", { dataType: "STRING", length: 40 })] });
  const area = asset("Area", "core.basicarea");
  const units = Array.from({ length: n }, (_, i) => asset(`U-${i + 1}`, t, area.uid, { variables: [{ name: "serial", value: `S${i}` }] }));
  return { p: project({ assetTypes: [t], assets: [area, ...units] }), t, area, units };
}

describe("executeRun", () => {
  it("respects the concurrency limit inside a level", async () => {
    const h = hierarchy(10);
    const fake = new FakeAm();
    fake.latencyMs = 5;
    const { run } = await deploy(h.p, fake, undefined, { concurrency: 3 });
    expect(run.status).toBe("completed");
    expect(fake.maxInFlight).toBeLessThanOrEqual(3);
    expect(fake.maxInFlight).toBeGreaterThan(1);
    expect(fake.assets.size).toBe(11);
  });

  it("marks dependents of a failed step as skipped-dependency", async () => {
    const h = hierarchy(3);
    const fake = new FakeAm({
      intercept: (req) =>
        req.method === "POST" && req.path === "/assets" && (req.body as { name: string }).name === "Area"
          ? { status: 400, body: { errors: [{ message: "Invalid asset", code: "x" }] }, attempts: 1, durationMs: 0 }
          : undefined,
    });
    const { run } = await deploy(h.p, fake);
    expect(statusOf(run, `assets:${h.area.uid}`)).toBe("failed");
    expect(run.state.items.find((i) => i.stepId === `assets:${h.area.uid}`)!.errors[0]).toContain("Invalid asset");
    for (const u of h.units) expect(statusOf(run, `assets:${u.uid}`)).toBe("skipped-dependency");
    expect(run.status).toBe("completed-with-errors");
    expect(statusOf(run, `assetTypes:${h.t.uid}`)).toBe("succeeded");
  });

  it("detects drift before an update, reports a diff and retries with the fresh ETag", async () => {
    const h = hierarchy(1);
    const fake = new FakeAm();
    const first = await deploy(h.p, fake);
    h.units[0]!.description = "Planned change";
    const plan = await analyze(h.p, fake, first.mapping);
    // Someone edits the asset after the analysis.
    const remote = fake.assetByName("U-1")!;
    remote.externalId = "changed-remotely";
    remote.etag++;
    const second = await execute(plan, fake, first.mapping);
    const stepId = `assets:${h.units[0]!.uid}`;
    const item = second.run.state.items.find((i) => i.stepId === stepId)!;
    expect(item.status).toBe("conflict");
    expect(item.conflict).toEqual([expect.objectContaining({ path: "externalId", kind: "added", after: "changed-remotely" })]);
    prepareRetry(second.run, { acceptDriftFor: [stepId] });
    await executeRun(second.run, second.mapping, { transport: fake, persistence: second.persistence, loadBlob: async () => undefined });
    expect(statusOf(second.run, stepId)).toBe("succeeded");
    expect(fake.assetByName("U-1")!.description).toBe("Planned change");
    const patches = fake.mutations().filter((r) => r.method === "PATCH");
    const patch = patches[patches.length - 1] as AmRequest;
    expect(String(patch.ifMatch)).toBe(String(remote.etag - 1));
  });

  it("marks a 412 from the server as conflict", async () => {
    const h = hierarchy(1);
    const fake = new FakeAm();
    const first = await deploy(h.p, fake);
    h.units[0]!.description = "x";
    const plan = await analyze(h.p, fake, first.mapping);
    fake.intercept = (req) => (req.method === "PATCH" ? { status: 412, body: { errors: [{ message: "changed" }] }, attempts: 1, durationMs: 0 } : undefined);
    const { run } = await execute(plan, fake, first.mapping);
    expect(statusOf(run, `assets:${h.units[0]!.uid}`)).toBe("conflict");
  });

  it("pauses and resumes without creating duplicates", async () => {
    const h = hierarchy(4);
    const fake = new FakeAm();
    const plan = await analyze(h.p, fake);
    const persistence = new MemoryPersistence();
    const mapping = emptyMapping(h.p.id, "conn-1", fake.tenant);
    const run = createRun({ plan, projectId: h.p.id, connectionId: "conn-1", connectionName: "Fake", mode: "deploy", concurrency: 1 });
    const control = new RunController();
    let done = 0;
    await executeRun(run, mapping, { transport: fake, persistence, loadBlob: async () => undefined }, {
      control,
      onUpdate: (r) => {
        done = r.state.items.filter((i) => i.status === "succeeded").length;
        if (done >= 2) control.pause();
      },
    });
    expect(run.status).toBe("paused");
    const created = fake.assets.size;
    expect(created).toBeLessThan(5);
    // The persisted record allows resuming after a reload.
    expect(persistence.runs.get(run.id)!.status).toBe("paused");
    expect(Object.keys(persistence.mapping!.entries).length).toBeGreaterThan(0);
    await executeRun(run, mapping, { transport: fake, persistence, loadBlob: async () => undefined });
    expect(run.status).toBe("completed");
    expect(fake.assets.size).toBe(5);
  });

  it("adopts an object created by an interrupted attempt instead of duplicating it", async () => {
    const h = hierarchy(1);
    const fake = new FakeAm();
    let failOnce = true;
    fake.intercept = (req) => {
      if (failOnce && req.method === "POST" && (req.body as { name?: string }).name === "U-1") {
        failOnce = false;
        // The request reaches the tenant, but the response is lost.
        void fake.request({ ...req });
        throw new Error("Network connection lost");
      }
      return undefined;
    };
    const first = await deploy(h.p, fake);
    expect(statusOf(first.run, `assets:${h.units[0]!.uid}`)).toBe("failed");
    expect(fake.assets.size).toBe(2);
    prepareRetry(first.run);
    await executeRun(first.run, first.mapping, { transport: fake, persistence: first.persistence, loadBlob: async () => undefined });
    expect(statusOf(first.run, `assets:${h.units[0]!.uid}`)).toBe("succeeded");
    expect(first.run.state.items.find((i) => i.stepId === `assets:${h.units[0]!.uid}`)!.note).toMatch(/adopted/);
    expect(fake.assets.size).toBe(2);
  });

  it("refuses blocked plans unless blocked steps are skipped", async () => {
    const h = hierarchy(1);
    const fake = new FakeAm();
    const first = await deploy(h.p, fake);
    h.units[0]!.twinType = "simulation";
    const plan = await analyze(h.p, fake, first.mapping);
    expect(executionGate(plan, false).ok).toBe(false);
    expect(executionGate(plan, true).ok).toBe(false); // nothing else to deploy
    h.units[0]!.description = "also changed";
    const area = h.area;
    area.description = "Area description";
    const plan2 = await analyze(h.p, fake, first.mapping);
    expect(executionGate(plan2, true).ok).toBe(true);
    await expect(execute(plan2, fake, first.mapping)).rejects.toThrow(/blocked/);
    const { run } = await execute(plan2, fake, first.mapping, { skipBlocked: true });
    expect(statusOf(run, `assets:${h.units[0]!.uid}`)).toBe("skipped");
    expect(statusOf(run, `assets:${area.uid}`)).toBe("succeeded");
    expect(run.status).toBe("completed-with-errors");
  });

  it("rolls back created objects and restores updated assets", async () => {
    const at = aspectType("Temp", { variables: [v("t")] });
    const t = assetType("Sensor", { aspects: [{ uid: "s-1", name: "temp", aspectType: { kind: "project", uid: at.uid } }] });
    const hall = asset("Hall", "core.basicarea");
    const s1 = asset("S1", t, hall.uid, { description: "before" });
    const p = project({ aspectTypes: [at], assetTypes: [t], assets: [hall, s1] });
    const fake = new FakeAm();
    const first = await deploy(p, fake);
    // Second deployment: change S1, move it, create S2 under a new area.
    const yard = asset("Yard", "core.basicarea");
    const s2 = asset("S2", t, yard.uid);
    p.assets.push(yard, s2);
    s1.description = "after";
    s1.parentUid = yard.uid;
    const plan = await analyze(p, fake, first.mapping);
    const persistence = new MemoryPersistence();
    const run = createRun({ plan, projectId: p.id, connectionId: "conn-1", connectionName: "Fake", mode: "deploy" });
    const audit: string[] = [];
    const services = { transport: fake, persistence, loadBlob: async () => undefined, audit: async (e: { action: string }) => audit.push(e.action) };
    await startRun(run, first.mapping, services);
    expect(run.status).toBe("completed");
    expect(fake.assetByName("S1")!.parentId).toBe(fake.assetByName("Yard")!.assetId);
    const rb = await rollbackRun(run, first.mapping, services);
    expect(rb.status).toBe("completed");
    expect(run.status).toBe("rolled-back");
    expect(fake.assetByName("S2")).toBeUndefined();
    expect(fake.assetByName("Yard")).toBeUndefined();
    expect(fake.assetByName("S1")!.description).toBe("before");
    expect(fake.assetByName("S1")!.parentId).toBe(fake.assetByName("Hall")!.assetId);
    expect(Object.values(first.mapping.entries).some((e) => e.name === "S2")).toBe(false);
    expect(audit).toEqual(["deployment.start", "deployment.finish", "rollback.start", "rollback.finish"]);
    expect(stepOf(rb.plan, `rollback:delete:assets:${yard.uid}`).dependsOn).toEqual(expect.arrayContaining([`rollback:delete:assets:${s2.uid}`]));
  });

  it("reports what cannot be rolled back", async () => {
    const t = assetType("Box", { variables: [v("a")] });
    const p = project({ assetTypes: [t] });
    const fake = new FakeAm();
    const first = await deploy(p, fake);
    t.variables[0]!.name = "b";
    const second = await deploy(p, fake, first.mapping);
    const rb = await rollbackRun(second.run, second.mapping, { transport: fake, persistence: second.persistence, loadBlob: async () => undefined });
    expect(rb.plan.notRevertible).toEqual([expect.objectContaining({ label: "Box" })]);
    expect(fake.assetTypes.get("acme.box")!.variables[0]!.name).toBe("b");
  });

  it("applies baselines and writes a report", async () => {
    const h = hierarchy(2);
    const fake = new FakeAm();
    const { run } = await deploy(h.p, fake);
    const draft = structuredClone(h.p);
    expect(applyRunBaselines(draft, run)).toBe(4);
    expect(draft.assetTypes[0]!.baseline).toEqual({ idSuffix: "Unit", instantiable: true });
    expect(draft.assetTypes[0]!.variables[0]!.baseline).toEqual({ dataType: "STRING", searchable: false, length: 40 });
    expect(draft.assets[1]!.baseline).toEqual({ twinType: "performance" });
    // The validator accepts the baselined project.
    expect(new ModelIndex(draft, BUILTIN_CORE_LIBRARY).assetTypes.size).toBe(1);
    const report = buildReport(run);
    expect(report.byPhase.map((p) => p.phase)).toEqual(["assetTypes", "assets"]);
    expect(report.steps).toHaveLength(4);
    const md = reportToMarkdown(report);
    expect(md).toContain("# Deployment report");
    expect(md).toContain("| Asset types | 1 | 1 | 0 |");
  });
});
