import { describe, expect, it } from "vitest";
import { produce } from "immer";
import { ROOT_ASSET_UID, type Project } from "@/domain/model";
import { ModelIndex } from "@/domain/resolve";
import { BUILTIN_CORE_LIBRARY } from "@/domain/coreLibrary";
import { asset, assetType, index, project, variable, aspectType } from "@/domain/__tests__/fixtures";
import { BULK_MAX, planTemplate } from "../bulkTemplate";
import { createFromCsvPlan, csvTemplate, planCsvImport, splitParentPath } from "../csvImport";
import { assetNameError, descriptionError, instantiableTypeOptions, resolveTypeToken } from "../types";
import { retainValuesForType, setAspectValue, setVariableValue, valuesNotOnType } from "../values";

function sample() {
  const pump = assetType("Pump");
  const abstract = assetType("Abstract", { instantiable: false });
  const site = asset("Plant A", "core.basicsite");
  const area = asset("Hall 1", "core.basicarea", { parentUid: site.uid });
  const existing = asset("P-001", pump, { parentUid: area.uid });
  const p = project({ assetTypes: [pump, abstract], assets: [site, area, existing] });
  return { p, ix: index(p), pump, site, area, existing };
}

describe("type options", () => {
  it("lists instantiable project and core types, excluding root hierarchy types", () => {
    const { ix, pump } = sample();
    const opts = instantiableTypeOptions(ix);
    const tokens = opts.map((o) => o.token);
    expect(tokens).toContain("Pump");
    expect(tokens).not.toContain("Abstract");
    expect(tokens).toContain("core.basicsite");
    expect(tokens).not.toContain("core.basicenterprise");
    expect(tokens).not.toContain("core.basicsubtenant");
    expect(tokens).not.toContain("core.basicasset");
    expect(resolveTypeToken(opts, "pump")?.ref).toEqual({ kind: "project", uid: pump.uid });
    expect(resolveTypeToken(opts, "{tenant}.Pump")?.ref).toEqual({ kind: "project", uid: pump.uid });
    expect(resolveTypeToken(opts, "CORE.BASICSITE")?.ref).toEqual({ kind: "core", id: "core.basicsite" });
    expect(resolveTypeToken(opts, "nope")).toBeUndefined();
  });

  it("validates names and descriptions", () => {
    expect(assetNameError("")).toMatch(/required/);
    expect(assetNameError("a/b")).toMatch(/\//);
    expect(assetNameError("x".repeat(129))).toMatch(/128/);
    expect(assetNameError("Pump 1")).toBeUndefined();
    expect(descriptionError("it's")).toMatch(/single quote/);
  });
});

describe("planTemplate", () => {
  it("expands names and reports duplicates with existing siblings", () => {
    const { ix, pump, area } = sample();
    const ref = { kind: "project" as const, uid: pump.uid };
    const ok = planTemplate(ix, { template: "P-{n:3}", count: 3, start: 2, type: ref, parentUid: area.uid });
    expect(ok.errors).toEqual([]);
    expect(ok.rows.map((r) => r.name)).toEqual(["P-002", "P-003", "P-004"]);
    const dup = planTemplate(ix, { template: "p-{n:3}", count: 3, start: 1, type: ref, parentUid: area.uid });
    expect(dup.rows).toEqual([]);
    expect(dup.errors.join(" ")).toMatch(/1 name\(s\) already exist.*"p-001"/);
  });

  it("enforces count, start, type and parent", () => {
    const { ix } = sample();
    const r = planTemplate(ix, { template: "", count: BULK_MAX + 1, start: -1, type: undefined, parentUid: "missing" });
    expect(r.errors).toHaveLength(5);
    const slash = planTemplate(ix, { template: "a/{n}", count: 2, start: 1, type: { kind: "core", id: "core.basicarea" }, parentUid: ROOT_ASSET_UID });
    expect(slash.errors[0]).toMatch(/must not contain/);
  });
});

describe("CSV import", () => {
  const header = "parentPath,name,type,externalId,description,timezone";

  it("resolves existing parents and earlier rows, then creates generation by generation", () => {
    const { p, ix, pump, area } = sample();
    const csv = [
      header,
      "Plant A / Hall 1,P-002,Pump,E2,,",
      ",Plant B,core.basicsite,,New site,Europe/Berlin",
      "Plant B,Hall 9,core.basicarea,,,",
      "plant b / hall 9,P-100,{tenant}.Pump,,,UTC",
    ].join("\n");
    const plan = planCsvImport(ix, csv, instantiableTypeOptions(ix));
    expect(plan.fileErrors).toEqual([]);
    expect(plan.rows.map((r) => r.errors)).toEqual([[], [], [], []]);
    expect(plan.rows[0]!.parent).toEqual({ kind: "existing", uid: area.uid });
    expect(plan.rows[2]!.parent).toEqual({ kind: "row", key: plan.rows[1]!.key });
    const next = produce(p, (d: Project) => {
      createFromCsvPlan(d, plan);
    });
    const nix = new ModelIndex(next, BUILTIN_CORE_LIBRARY);
    const hall9 = next.assets.find((a) => a.name === "Hall 9")!;
    const p100 = next.assets.find((a) => a.name === "P-100")!;
    expect(p100.parentUid).toBe(hall9.uid);
    expect(p100.type).toEqual({ kind: "project", uid: pump.uid });
    expect(p100.timezone).toBe("UTC");
    expect(nix.hierarchyPath(p100.uid).map((a) => a.name)).toEqual(["Tenant root", "Plant B", "Hall 9", "P-100"]);
    expect(next.assets.find((a) => a.name === "Plant B")!.description).toBe("New site");
    expect(next.assets.find((a) => a.name === "P-002")!.externalId).toBe("E2");
  });

  it("reports per-row errors", () => {
    const { ix } = sample();
    const csv = [
      header,
      "Nowhere,X,Pump,,,",
      "Plant A / Hall 1,p-001,Pump,,,",
      ",Bad,Abstract,,,",
      ",TZ,core.basicsite,,,Asia/Kathmandu",
      ",Quote,core.basicsite,,it's,",
      ",Dup,core.basicsite,,,",
      ",dup,core.basicsite,,,",
      "Unknown parent row,Child,core.basicarea,,,",
      ",Root type,core.basicenterprise,,,",
    ].join("\n");
    const plan = planCsvImport(ix, csv, instantiableTypeOptions(ix));
    const errs = plan.rows.map((r) => r.errors.join(" | "));
    expect(errs[0]).toMatch(/Unknown parent "Nowhere"/);
    expect(errs[1]).toMatch(/already exists/);
    expect(errs[2]).toMatch(/non-instantiable type "Abstract"/);
    expect(errs[3]).toMatch(/15 or 45 minutes/);
    expect(errs[4]).toMatch(/single quote/);
    expect(errs[5]).toBe("");
    expect(errs[6]).toMatch(/already exists/);
    expect(errs[8]).toMatch(/core.basicenterprise/);
    expect(plan.invalid).toBe(8);
    expect(() => createFromCsvPlan(sample().p, plan)).toThrow();
  });

  it("flags children of rows with errors and file-level problems", () => {
    const { ix } = sample();
    const plan = planCsvImport(ix, [header, ",Bad/Name,core.basicsite,,,", ",Ok,nope,,,", "Ok,Child,core.basicarea,,,"].join("\n"), instantiableTypeOptions(ix));
    expect(plan.rows[2]!.errors.join()).toMatch(/line 3\) has errors/);
    expect(planCsvImport(ix, "", []).fileErrors).toEqual(["The file is empty."]);
    expect(planCsvImport(ix, "name;other\nx;y", []).fileErrors[0]).toMatch(/Missing required column\(s\): type/);
    expect(planCsvImport(ix, "Name,Type,Extra\n", []).fileErrors).toEqual(["The file has a header but no rows."]);
  });

  it("splits parent paths and provides a template", () => {
    expect(splitParentPath(" Plant A / Hall 1 ")).toEqual(["Plant A", "Hall 1"]);
    expect(splitParentPath("")).toEqual([]);
    expect(csvTemplate()).toBe(`${header}\r\n`);
  });
});

describe("value helpers", () => {
  it("sets, clears and drops values not on a type", () => {
    const at = aspectType("Nameplate", { category: "static", variables: [variable("maker", { dataType: "STRING" })] });
    const dyn = aspectType("Telemetry");
    const t = assetType("Motor", {
      variables: [variable("rpm")],
      aspects: [
        { uid: "asp1", name: "plate", aspectType: { kind: "project", uid: at.uid } },
        { uid: "asp2", name: "telemetry", aspectType: { kind: "project", uid: dyn.uid } },
      ],
    });
    const m = asset("M1", t);
    const p = project({ aspectTypes: [at, dyn], assetTypes: [t], assets: [m] });
    const resolved = index(p).resolveAssetType({ kind: "project", uid: t.uid });
    const next = produce(m, (a) => {
      setVariableValue(a, "rpm", "1500");
      setVariableValue(a, "old", "x");
      setAspectValue(a, "plate", "maker", "ACME");
      setAspectValue(a, "plate", "gone", "y");
    });
    expect(valuesNotOnType(next, resolved)).toEqual({ variables: ["old"], aspectValues: ["plate.gone"] });
    const kept = produce(next, (a) => retainValuesForType(a, resolved));
    expect(kept.variables).toEqual([{ name: "rpm", value: "1500" }]);
    expect(kept.aspects).toEqual([{ name: "plate", variables: [{ name: "maker", value: "ACME" }] }]);
    const cleared = produce(kept, (a) => {
      setVariableValue(a, "RPM", "");
      setAspectValue(a, "plate", "maker", undefined);
    });
    expect(cleared.variables).toEqual([]);
    expect(cleared.aspects).toEqual([]);
  });
});
