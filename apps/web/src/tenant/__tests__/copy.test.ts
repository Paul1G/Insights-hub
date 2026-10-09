import { describe, expect, it } from "vitest";
import { ROOT_ASSET_UID } from "@/domain/model";
import { validateProject } from "@/domain/validator";
import { FakeAm } from "@/deploy/__tests__/fakeAm";
import { aspectType, asset, assetType, deploy, file, indexOf, project, v } from "@/deploy/__tests__/helpers";
import { applyResolutions, compatibilityProblems, extractProject, findConflicts, selectionClosure, type Resolution } from "../copy";
import { readTenant } from "../read";

function source() {
  const metrics = aspectType("Metrics", { variables: [v("power")] });
  const unused = aspectType("Unused");
  const base = assetType("Base", { aspects: [{ uid: "b-1", name: "metrics", aspectType: { kind: "project", uid: metrics.uid } }] });
  const pump = assetType("Pump", { parent: { kind: "project", uid: base.uid }, variables: [v("rpm", { dataType: "INT" })] });
  const doc = file("doc.txt", "b", "s");
  const site = asset("Site", "core.basicsite");
  const p1 = asset("P1", pump, site.uid, { fileAssignments: [{ key: "doc", fileUid: doc.uid }] });
  const other = asset("Other", "core.basicarea");
  const p = project({ aspectTypes: [metrics, unused], assetTypes: [base, pump], assets: [site, p1, other], files: [doc] });
  return { p, metrics, unused, base, pump, doc, site, p1, other };
}

describe("cross-tenant copy helpers", () => {
  it("closes the selection over parents, aspect types, asset types of assets and files", () => {
    const s = source();
    const closure = selectionClosure(indexOf(s.p), { aspectTypes: new Set(), assetTypes: new Set(), assetRoots: new Set([s.site.uid]) });
    expect([...closure.assets].sort()).toEqual([s.site.uid, s.p1.uid].sort());
    expect([...closure.assetTypes].sort()).toEqual([s.base.uid, s.pump.uid].sort());
    expect([...closure.aspectTypes]).toEqual([s.metrics.uid]);
    expect([...closure.files]).toEqual([s.doc.uid]);
    expect(closure.added.assetTypes).toBe(2);
    const copy = extractProject(s.p, closure, "Copy");
    expect(copy.assets.map((a) => a.name)).toEqual(["Tenant root", "Site", "P1"]);
    expect(copy.assets.find((a) => a.name === "Site")!.parentUid).toBe(ROOT_ASSET_UID);
    expect(copy.aspectTypes.map((t) => t.name)).toEqual(["Metrics"]);
    expect(validateProject(indexOf(copy)).errors).toBe(0);
  });

  it("finds case-insensitive collisions and validates mapping to existing target types", async () => {
    const s = source();
    const target = new FakeAm({ tenant: "dst" });
    // The target already has a compatible Metrics and an incompatible PUMP.
    const tm = aspectType("Metrics", { variables: [v("power"), v("extra")] });
    const tp = assetType("PUMP", { variables: [v("rpm", { dataType: "STRING" })] });
    await deploy(project({ aspectTypes: [tm], assetTypes: [tp] }), target);
    const snap = await readTenant(target, { tenant: "dst" });
    const conflicts = findConflicts(s.p, "dst", snap);
    expect(conflicts.map((c) => [c.name, c.collision])).toEqual([
      ["Metrics", "id+name"],
      ["Pump", "id+name"],
    ]);
    const index = indexOf(s.p);
    const resolutions = new Map<string, Resolution>([[s.metrics.uid, { action: "map", targetId: "dst.Metrics" }]]);
    expect(compatibilityProblems("aspectType", s.metrics.uid, "dst.Metrics", s.p, index, snap, resolutions)).toEqual([]);
    const pumpProblems = compatibilityProblems("assetType", s.pump.uid, "dst.PUMP", s.p, index, snap, resolutions);
    expect(pumpProblems.some((p) => p.includes("rpm"))).toBe(true);

    resolutions.set(s.pump.uid, { action: "rename", idSuffix: "Pump2", name: "Pump 2" });
    const resolved = applyResolutions(s.p, resolutions);
    expect(resolved.aspectTypes.map((t) => t.name)).toEqual(["Unused"]);
    expect(resolved.assetTypes.find((t) => t.uid === s.base.uid)!.aspects[0]!.aspectType).toEqual({ kind: "external", id: "dst.Metrics" });
    expect(resolved.assetTypes.find((t) => t.uid === s.pump.uid)!.idSuffix).toBe("Pump2");
    expect(findConflicts(resolved, "dst", snap)).toEqual([]);
  });
});
