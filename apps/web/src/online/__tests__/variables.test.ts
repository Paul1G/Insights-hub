import { describe, expect, it } from "vitest";
import {
  aspectTypeVariablePatches,
  assetTypeVariableArrays,
  assetTypeVariableUpdateMap,
  draftFromVariable,
  newVariableDraft,
  validateVariableDrafts,
  type VariableOwner,
} from "../variables";
import { variable } from "./fakes";

const STATIC: VariableOwner = { kind: "aspectType", category: "static" };
const DYNAMIC: VariableOwner = { kind: "aspectType", category: "dynamic" };
const ASSET_TYPE: VariableOwner = { kind: "assetType" };

const errorsOf = (issues: ReturnType<typeof validateVariableDrafts>, key: string) =>
  issues.filter((i) => i.key === key && i.severity === "error").map((i) => i.message);

describe("validateVariableDrafts", () => {
  it("validates names (pattern, reserved, unique, family)", () => {
    const a = { ...newVariableDraft(STATIC), name: "1abc" };
    const b = { ...newVariableDraft(STATIC), name: "description" };
    const c = { ...newVariableDraft(STATIC), name: "temp" };
    const d = { ...newVariableDraft(STATIC), name: "TEMP" };
    const e = { ...newVariableDraft(ASSET_TYPE), name: "serial" };
    const issues = validateVariableDrafts([a, b, c, d], STATIC);
    expect(errorsOf(issues, a.key)[0]).toMatch(/must not start with a digit/);
    expect(errorsOf(issues, b.key)[0]).toMatch(/reserved/);
    expect(errorsOf(issues, d.key)[0]).toMatch(/unique/);
    expect(errorsOf(validateVariableDrafts([e], ASSET_TYPE, ["Serial"]), e.key)[0]).toMatch(/type family/);
  });

  it("blocks immutable changes unless recreated, and only lets length grow", () => {
    const d = draftFromVariable(variable("serial", { length: 40 }));
    d.dataType = "INT";
    expect(errorsOf(validateVariableDrafts([d], ASSET_TYPE), d.key).join()).toMatch(/Delete and recreate/);
    d.recreate = true;
    d.length = "";
    expect(errorsOf(validateVariableDrafts([d], ASSET_TYPE), d.key)).toEqual([]);

    const s = draftFromVariable(variable("label", { length: 40 }));
    s.length = "20";
    expect(errorsOf(validateVariableDrafts([s], ASSET_TYPE), s.key)[0]).toMatch(/only be increased/);
    s.length = "80";
    expect(errorsOf(validateVariableDrafts([s], ASSET_TYPE), s.key)).toEqual([]);
  });

  it("applies default value and BIG_STRING rules per owner", () => {
    const dyn = { ...newVariableDraft(DYNAMIC), name: "x", defaultValue: "a" };
    expect(errorsOf(validateVariableDrafts([dyn], DYNAMIC), dyn.key)[0]).toMatch(/static variables/);
    const big = { ...newVariableDraft(ASSET_TYPE), name: "notes", dataType: "BIG_STRING" as const };
    expect(errorsOf(validateVariableDrafts([big], ASSET_TYPE), big.key)[0]).toMatch(/dynamic aspect types/);
    const bad = { ...newVariableDraft(ASSET_TYPE), name: "n", dataType: "INT" as const, defaultValue: "1.5" };
    expect(errorsOf(validateVariableDrafts([bad], ASSET_TYPE), bad.key)[0]).toMatch(/whole number/);
    const kept = draftFromVariable(variable("v", { defaultValue: "x" }));
    kept.defaultValue = "";
    expect(errorsOf(validateVariableDrafts([kept], ASSET_TYPE), kept.key)[0]).toMatch(/cannot be removed/);
  });

  it("rejects interchanged names in one request", () => {
    const a = draftFromVariable(variable("a"));
    const b = draftFromVariable(variable("b"));
    a.name = "b";
    b.name = "a";
    const issues = validateVariableDrafts([a, b], ASSET_TYPE);
    expect(errorsOf(issues, a.key).join()).toMatch(/interchanged/);
    const n = { ...newVariableDraft(ASSET_TYPE), name: "a" };
    const deleted = draftFromVariable(variable("a"));
    deleted.deleted = true;
    expect(errorsOf(validateVariableDrafts([deleted, n], ASSET_TYPE), n.key).join()).toMatch(/interchanged or reused/);
  });
});

describe("aspectTypeVariablePatches", () => {
  it("adds, updates and deletes (null) in one map", () => {
    const current = [variable("temp", { unit: "C", dataType: "DOUBLE" }), variable("old")];
    const drafts = current.map(draftFromVariable);
    drafts[0]!.unit = "K";
    drafts[0]!.name = "temperature";
    drafts[1]!.deleted = true;
    const added = { ...newVariableDraft(STATIC), name: "fresh", dataType: "INT" as const, defaultValue: "3" };
    const maps = aspectTypeVariablePatches(current, [...drafts, added], "static");
    expect(maps).toHaveLength(1);
    expect(maps[0]).toEqual({
      temp: { name: "temperature", dataType: "DOUBLE", searchable: false, unit: "K" },
      old: null,
      fresh: { name: "fresh", dataType: "INT", searchable: false, defaultValue: "3", qualityCode: false },
    });
  });

  it("splits recreations into delete-then-add", () => {
    const current = [variable("level", { dataType: "INT" })];
    const d = draftFromVariable(current[0]!);
    d.dataType = "DOUBLE";
    d.recreate = true;
    const maps = aspectTypeVariablePatches(current, [d], "dynamic");
    expect(maps).toEqual([{ level: null }, { level: { name: "level", dataType: "DOUBLE", searchable: false, qualityCode: false } }]);
  });

  it("never sends default values for dynamic aspect types", () => {
    const current = [variable("s", { length: 10 })];
    const d = draftFromVariable(current[0]!);
    d.length = "20";
    const maps = aspectTypeVariablePatches(current, [d], "dynamic");
    expect(maps[0]!.s).not.toHaveProperty("defaultValue");
    expect(maps[0]!.s).toMatchObject({ length: 20 });
  });
});

describe("asset type variable bodies", () => {
  it("update map carries only changed name/unit/length/defaultValue", () => {
    const current = [variable("rpm", { dataType: "DOUBLE", unit: "1/min" }), variable("serial", { length: 20 })];
    const drafts = current.map(draftFromVariable);
    drafts[0]!.unit = "rpm";
    drafts[1]!.length = "40";
    drafts[1]!.defaultValue = "n/a";
    expect(assetTypeVariableUpdateMap(current, drafts)).toEqual({
      rpm: { unit: "rpm" },
      serial: { length: 40, defaultValue: "n/a" },
    });
  });

  it("arrays: removals, additions and recreations", () => {
    const current = [variable("a"), variable("b", { dataType: "INT" }), variable("c")];
    const drafts = current.map(draftFromVariable);
    drafts[0]!.deleted = true;
    drafts[1]!.dataType = "LONG";
    drafts[1]!.recreate = true;
    const added = { ...newVariableDraft(ASSET_TYPE), name: "d" };
    const res = assetTypeVariableArrays(current, [...drafts, added]);
    expect(res.changed).toBe(true);
    expect(res.removal?.map((v) => v.name)).toEqual(["c"]);
    expect(res.final.map((v) => `${v.name}:${v.dataType}`)).toEqual(["c:STRING", "b:LONG", "d:STRING"]);
    expect(assetTypeVariableUpdateMap(current, drafts)).toEqual({});
  });

  it("no change → not changed", () => {
    const current = [variable("a")];
    const res = assetTypeVariableArrays(current, current.map(draftFromVariable));
    expect(res.changed).toBe(false);
    expect(res.removal).toBeUndefined();
  });
});
