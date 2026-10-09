import { describe, expect, it } from "vitest";
import { DEFAULT_GUARDRAILS, type GuardrailSettings } from "../rules";
import { validateProject } from "../validator";
import { asset, aspectType, assetType, index, project, variable } from "./fixtures";

const codes = (p: ReturnType<typeof project>, settings?: GuardrailSettings) =>
  validateProject(index(p), settings).issues.map((i) => `${i.severity}:${i.code}`);

describe("validator — naming", () => {
  it("accepts a clean minimal model", () => {
    const apt = aspectType("Electrical", { variables: [variable("PWR_OUT", { unit: "MW" })] });
    const t = assetType("WindTurbine", { aspects: [{ uid: "asp1", name: "electrical", aspectType: { kind: "project", uid: apt.uid } }] });
    const r = validateProject(index(project({ aspectTypes: [apt], assetTypes: [t], assets: [asset("N-001", t)] })));
    expect(r.errors).toBe(0);
  });

  it("rejects reserved words and invalid variable names", () => {
    const t = assetType("Pump", { variables: [variable("name", { dataType: "STRING" }), variable("1abc")] });
    const c = codes(project({ assetTypes: [t] }));
    expect(c).toContain("error:VAR_NAME_RESERVED");
    expect(c).toContain("error:VAR_NAME_PATTERN");
  });

  it("treats names case-insensitively", () => {
    const a = aspectType("Motor");
    const b = aspectType("motor", { idSuffix: "motor2" });
    expect(codes(project({ aspectTypes: [a, b] }))).toContain("error:ASPECT_TYPE_NAME_DUPLICATE");
    const t = assetType("Pump", { variables: [variable("Speed"), variable("speed")] });
    expect(codes(project({ assetTypes: [t] }))).toContain("error:VAR_NAME_DUPLICATE");
  });

  it("enforces variable name uniqueness across the type family", () => {
    const parent = assetType("Machine", { variables: [variable("serial", { dataType: "STRING" })] });
    const child = assetType("Pump", {
      parent: { kind: "project", uid: parent.uid },
      variables: [variable("Serial", { dataType: "STRING" })],
    });
    const c = codes(project({ assetTypes: [parent, child] }));
    expect(c.filter((x) => x === "error:VAR_NAME_FAMILY_CONFLICT").length).toBe(2);
  });

  it("rejects single quotes in aspect type descriptions and slashes in asset names", () => {
    const apt = aspectType("A", { description: "it's" });
    const t = assetType("T");
    const c = codes(project({ aspectTypes: [apt], assetTypes: [t], assets: [asset("a/b", t)] }));
    expect(c).toContain("error:DESCRIPTION_QUOTE");
    expect(c).toContain("error:ASSET_NAME_PATTERN");
  });
});

describe("validator — variable rules", () => {
  it("only allows BIG_STRING in dynamic aspect types", () => {
    const s = aspectType("S", { category: "static", variables: [variable("blob", { dataType: "BIG_STRING", length: 1000 })] });
    const d = aspectType("D", { variables: [variable("blob", { dataType: "BIG_STRING", length: 1000 })] });
    const c = codes(project({ aspectTypes: [s, d] }));
    expect(c.filter((x) => x === "error:VAR_BIG_STRING_STATIC").length).toBe(1);
  });

  it("checks length ranges and default value compatibility", () => {
    const t = assetType("T", {
      variables: [
        variable("a", { dataType: "STRING", length: 300 }),
        variable("b", { dataType: "INT", length: 5 }),
        variable("c", { dataType: "INT", defaultValue: "1.5" }),
        variable("d", { dataType: "BOOLEAN", defaultValue: "true" }),
      ],
    });
    const c = codes(project({ assetTypes: [t] }));
    expect(c).toContain("error:VAR_LENGTH_RANGE");
    expect(c).toContain("error:VAR_LENGTH_UNSUPPORTED");
    expect(c.filter((x) => x === "error:VAR_DEFAULT_INVALID").length).toBe(1);
  });

  it("forbids default values on dynamic aspect variables", () => {
    const d = aspectType("D", { variables: [variable("x", { defaultValue: "1" })] });
    expect(codes(project({ aspectTypes: [d] }))).toContain("error:VAR_DEFAULT_DYNAMIC");
  });

  it("enforces immutability against the baseline", () => {
    const t = assetType("T", {
      variables: [
        variable("a", { dataType: "INT", baseline: { dataType: "STRING", searchable: false } }),
        variable("b", { searchable: true, baseline: { dataType: "DOUBLE", searchable: false } }),
        variable("c", { dataType: "STRING", length: 50, baseline: { dataType: "STRING", searchable: false, length: 100 } }),
        variable("d", { dataType: "STRING", length: 200, baseline: { dataType: "STRING", searchable: false, length: 100 } }),
      ],
    });
    const c = codes(project({ assetTypes: [t] }));
    expect(c).toContain("error:VAR_DATATYPE_IMMUTABLE");
    expect(c).toContain("error:VAR_SEARCHABLE_IMMUTABLE");
    expect(c.filter((x) => x === "error:VAR_LENGTH_DECREASE").length).toBe(1);
  });

  it("forbids any length change on dynamic STRING variables once created", () => {
    const d = aspectType("D", {
      variables: [variable("s", { dataType: "STRING", length: 200, baseline: { dataType: "STRING", searchable: false, length: 100 } })],
    });
    expect(codes(project({ aspectTypes: [d] }))).toContain("error:VAR_LENGTH_DYNAMIC_IMMUTABLE");
  });
});

describe("validator — assets", () => {
  it("rejects 15/45-minute timezones and accepts 30-minute ones", () => {
    const t = assetType("T");
    const c = codes(project({
      assetTypes: [t],
      assets: [asset("np", t, { timezone: "Asia/Kathmandu" }), asset("in", t, { timezone: "Asia/Kolkata" })],
    }));
    expect(c.filter((x) => x === "error:TIMEZONE_INVALID").length).toBe(1);
  });

  it("locks timezone after creation", () => {
    const t = assetType("T");
    const a = asset("x", t, { timezone: "Europe/Berlin", baseline: { timezone: "UTC", twinType: "performance" } });
    expect(codes(project({ assetTypes: [t], assets: [a] }))).toContain("error:TIMEZONE_IMMUTABLE");
  });

  it("rejects abstract types, root hierarchy types and duplicate siblings", () => {
    const abstract = assetType("Abstract", { instantiable: false });
    const c = codes(project({
      assetTypes: [abstract],
      assets: [asset("a", abstract), asset("b", "core.basicenterprise"), asset("Dup", "core.basicsite"), asset("dup", "core.basicsite")],
    }));
    expect(c).toContain("error:ASSET_TYPE_ABSTRACT");
    expect(c).toContain("error:ASSET_ROOT_TYPE");
    expect(c).toContain("error:ASSET_SIBLING_DUPLICATE");
  });

  it("validates variable values against the type", () => {
    const t = assetType("T", { variables: [variable("rpm", { dataType: "INT" })] });
    const c = codes(project({
      assetTypes: [t],
      assets: [asset("x", t, { variables: [{ name: "RPM", value: "abc" }, { name: "nope", value: "1" }] })],
    }));
    expect(c).toContain("error:VALUE_INVALID");
    expect(c).toContain("error:VALUE_UNKNOWN_VARIABLE");
  });

  it("rejects static values on dynamic aspects", () => {
    const d = aspectType("D");
    const t = assetType("T", { aspects: [{ uid: "x", name: "metrics", aspectType: { kind: "project", uid: d.uid } }] });
    const a = asset("x", t, { aspects: [{ name: "metrics", variables: [{ name: "value", value: "1" }] }] });
    expect(codes(project({ aspectTypes: [d], assetTypes: [t], assets: [a] }))).toContain("error:VALUE_DYNAMIC_ASPECT");
  });

  it("detects hierarchy cycles", () => {
    const t = assetType("T");
    const a = asset("a", t);
    const b = asset("b", t, { parentUid: a.uid });
    a.parentUid = b.uid;
    expect(codes(project({ assetTypes: [t], assets: [a, b] }))).toContain("error:ASSET_CYCLE");
  });
});

describe("validator — guardrails", () => {
  const manyVars = (n: number) => Array.from({ length: n }, (_, i) => variable(`v${i}`));

  it("warns above recommended and errors above technical limits", () => {
    const apt11 = aspectType("A11", { variables: manyVars(11) });
    const apt21 = aspectType("A21", { variables: manyVars(21) });
    const c = codes(project({ aspectTypes: [apt11, apt21] }));
    expect(c.filter((x) => x === "warning:REC_ASPECT_TYPE_VARIABLES").length).toBe(2);
    expect(c.filter((x) => x === "error:TECH_ASPECT_TYPE_VARIABLES").length).toBe(1);
  });

  it("reports technical limits as info under the recommended-only profile", () => {
    const apt21 = aspectType("A21", { variables: manyVars(21) });
    const c = codes(project({ aspectTypes: [apt21] }), { ...DEFAULT_GUARDRAILS, profile: "recommended" });
    expect(c).toContain("info:TECH_ASPECT_TYPE_VARIABLES");
    expect(c).not.toContain("error:TECH_ASPECT_TYPE_VARIABLES");
  });

  it("honours adjusted recommended thresholds", () => {
    const apt = aspectType("A", { variables: manyVars(6) });
    const settings: GuardrailSettings = { ...DEFAULT_GUARDRAILS, recommended: { ...DEFAULT_GUARDRAILS.recommended, maxVariablesPerAspectType: 5 } };
    expect(codes(project({ aspectTypes: [apt] }), settings)).toContain("warning:REC_ASPECT_TYPE_VARIABLES");
  });

  it("limits inheritance depth to 5 steps below core.basicasset", () => {
    const chain = [assetType("L1")];
    for (let i = 2; i <= 6; i++) chain.push(assetType(`L${i}`, { parent: { kind: "project", uid: chain[i - 2]!.uid } }));
    const r = validateProject(index(project({ assetTypes: chain })));
    const depthIssues = r.issues.filter((i) => i.code === "TECH_ASSET_TYPE_DEPTH");
    expect(depthIssues.map((i) => i.target.label)).toEqual(["L6"]);
  });

  it("limits direct variables per asset type to 25", () => {
    const t = assetType("T", { variables: manyVars(26) });
    expect(codes(project({ assetTypes: [t] }))).toContain("error:TECH_DIRECT_VARIABLES");
  });

  it("limits hierarchy depth to 20 levels including the root", () => {
    const t = assetType("T");
    const assets = [asset("lvl2", t)];
    for (let i = 3; i <= 21; i++) assets.push(asset(`lvl${i}`, t, { parentUid: assets[assets.length - 1]!.uid }));
    const r = validateProject(index(project({ assetTypes: [t], assets })));
    expect(r.issues.filter((i) => i.code === "TECH_HIERARCHY_DEPTH").map((i) => i.target.label)).toEqual(["lvl21"]);
  });
});
