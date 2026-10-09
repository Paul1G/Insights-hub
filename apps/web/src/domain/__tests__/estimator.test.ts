import { describe, expect, it } from "vitest";
import { estimateProject, estimateType } from "../estimator";
import { analyzeHealth, proposeSplit } from "../health";
import { DEFAULT_GUARDRAILS } from "../rules";
import { asset, aspectType, assetType, index, project, variable } from "./fixtures";

describe("asset attribute estimator", () => {
  it("counts static variables, aspect variables and inherited tenant types", () => {
    const metrics = aspectType("Metrics", { variables: [variable("a"), variable("b"), variable("c")] });
    const base = assetType("Machine", { variables: [variable("serial", { dataType: "STRING" })] });
    const pump = assetType("Pump", {
      parent: { kind: "project", uid: base.uid },
      variables: [variable("rpm")],
      aspects: [{ uid: "x", name: "metrics", aspectType: { kind: "project", uid: metrics.uid } }],
    });
    const p = project({ aspectTypes: [metrics], assetTypes: [base, pump], assets: [asset("p1", pump), asset("p2", pump)] });
    const est = estimateType(index(p), { kind: "project", uid: pump.uid })!;
    expect(est.direct).toBe(1);
    expect(est.inheritedStatic).toBe(1);
    expect(est.perAsset).toBe(5);
    expect(estimateProject(index(p)).totalAttributes).toBe(10);
  });

  it("does not bill core parents or core aspect types, and counts at least 1 per asset", () => {
    const t = assetType("Device", {
      parent: { kind: "core", id: "core.basicdevice" },
      aspects: [{ uid: "x", name: "contact", aspectType: { kind: "core", id: "core.contactpoint" } }],
    });
    const p = project({ assetTypes: [t], assets: [asset("d", t), asset("site", "core.basicsite"), asset("raw", "core.basicasset")] });
    const est = estimateProject(index(p));
    expect(estimateType(index(p), { kind: "project", uid: t.uid })!.billable).toBe(0);
    expect(est.totalAttributes).toBe(3);
    expect(est.ootbInstances).toBe(2);
  });

  it("supports planned instance counts for what-if sizing", () => {
    const t = assetType("T", { variables: [variable("a"), variable("b")] });
    const p = project({ assetTypes: [t] });
    const est = estimateProject(index(p), { [`project:${t.uid}`]: 1000 });
    expect(est.totalAttributes).toBe(2000);
  });
});

describe("model health", () => {
  it("proposes a split by prefix within the max group size", () => {
    const names = ["temp_a", "temp_b", "temp_c", "pres_a", "pres_b", "x"];
    const groups = proposeSplit(names, 3);
    expect(groups.every((g) => g.length <= 3)).toBe(true);
    expect(groups.flat().sort()).toEqual([...names].sort());
    expect(groups[0]).toEqual(["temp_a", "temp_b", "temp_c"]);
  });

  it("flags oversized aspect types, deep inheritance and unused types", () => {
    const big = aspectType("Big", { variables: Array.from({ length: 12 }, (_, i) => variable(`v${i}`)) });
    const chain = [assetType("L1", { aspects: [{ uid: "x", name: "big", aspectType: { kind: "project", uid: big.uid } }] })];
    for (let i = 2; i <= 4; i++) chain.push(assetType(`L${i}`, { parent: { kind: "project", uid: chain[i - 2]!.uid } }));
    const p = project({ aspectTypes: [big], assetTypes: chain, assets: [asset("x", chain[3]!)] });
    const report = analyzeHealth(index(p), DEFAULT_GUARDRAILS);
    const ids = report.findings.map((f) => f.id.split(":")[0]);
    expect(ids).toContain("split-aspect");
    expect(ids).toContain("flatten");
    expect(report.score).toBeLessThan(100);
  });
});

describe("official sample project", () => {
  it("is valid and estimates 5 attributes per turbine", async () => {
    const { createSampleProject } = await import("../sample");
    const { ProjectSchema } = await import("../model");
    const { validateProject } = await import("../validator");
    const p = createSampleProject();
    expect(ProjectSchema.safeParse(p).success).toBe(true);
    const ix = index(p);
    expect(validateProject(ix).errors).toBe(0);
    // 4 turbines × (1 static + 2×2 aspect variables) + 2 OOTB areas × 1
    expect(estimateProject(ix).totalAttributes).toBe(4 * 5 + 2);
  });
});
