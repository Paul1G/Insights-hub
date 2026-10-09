import { describe, expect, it } from "vitest";
import { diffProjects, diffValues } from "../diff";
import { ROOT_ASSET_UID } from "../model";
import {
  DomainError,
  assetTypeDeletionImpact,
  assetTypeVariableBlastRadius,
  cloneSubtree,
  deleteAssetSubtree,
  deleteAssetType,
  deleteAssetTypeVariable,
  expandNameTemplate,
  moveAsset,
  recreateVariable,
  renameAssetTypeVariable,
  uniqueName,
} from "../ops";
import { checkTimezone } from "../timezone";
import { checkValue } from "../values";
import { checkContentType } from "../mime";
import { asset, assetType, index, project, variable } from "./fixtures";

function sample() {
  const parent = assetType("Machine", { variables: [variable("serial", { dataType: "STRING" })] });
  const pump = assetType("Pump", { parent: { kind: "project", uid: parent.uid } });
  const site = asset("Site", "core.basicsite");
  const p1 = asset("P1", pump, { parentUid: site.uid, variables: [{ name: "serial", value: "S-1" }] });
  const p2 = asset("P2", pump, { parentUid: site.uid });
  const sub = asset("Sub", "core.basicarea", { parentUid: p1.uid });
  return { p: project({ assetTypes: [parent, pump], assets: [site, p1, p2, sub] }), parent, pump, site, p1, p2, sub };
}

describe("ops — hierarchy", () => {
  it("refuses to delete or move the root and prevents cycles", () => {
    const { p, site, sub } = sample();
    expect(() => deleteAssetSubtree(p, index(p), ROOT_ASSET_UID)).toThrow(DomainError);
    expect(() => moveAsset(p, index(p), site.uid, sub.uid)).toThrow(/own subtree/);
  });

  it("deletes a whole subtree", () => {
    const { p, site } = sample();
    const n = deleteAssetSubtree(p, index(p), site.uid);
    expect(n).toBe(4);
    expect(p.assets.map((a) => a.uid)).toEqual([ROOT_ASSET_UID]);
  });

  it("clones a subtree with fresh uids and a unique name", () => {
    const { p, p1 } = sample();
    p1.baseline = { twinType: "performance" };
    const ix = index(p);
    const newRoot = cloneSubtree(p, ix, p1.uid);
    const clone = p.assets.find((a) => a.uid === newRoot)!;
    expect(clone.name).toBe("P1 (copy)");
    expect(clone.baseline).toBeUndefined();
    expect(p.assets.filter((a) => a.parentUid === newRoot).map((a) => a.name)).toEqual(["Sub"]);
    expect(p.assets.length).toBe(7);
  });

  it("expands bulk name templates", () => {
    expect(expandNameTemplate("Pump-{n:3}", 3, 9)).toEqual(["Pump-009", "Pump-010", "Pump-011"]);
    expect(expandNameTemplate("Fan", 2)).toEqual(["Fan_1", "Fan_2"]);
  });
});

describe("ops — types and variables", () => {
  it("propagates variable renames to asset values of descendant types", () => {
    const { p, parent, p1 } = sample();
    renameAssetTypeVariable(p, index(p), parent.uid, parent.variables[0]!.uid, "serialNo");
    expect(p.assets.find((a) => a.uid === p1.uid)!.variables).toEqual([{ name: "serialNo", value: "S-1" }]);
  });

  it("computes the blast radius and removes values on delete", () => {
    const { p, parent } = sample();
    const radius = assetTypeVariableBlastRadius(index(p), parent.uid, "serial");
    expect(radius).toMatchObject({ assets: 2, assetsWithValues: 1 });
    expect(radius.assetTypes.map((t) => t.name)).toEqual(["Machine", "Pump"]);
    deleteAssetTypeVariable(p, index(p), parent.uid, parent.variables[0]!.uid);
    expect(p.assets.every((a) => a.variables.length === 0)).toBe(true);
  });

  it("delete-and-recreate replaces the variable without baseline", () => {
    const { p, parent } = sample();
    parent.variables[0]!.baseline = { dataType: "STRING", searchable: false, length: 255 };
    const before = parent.variables[0]!.uid;
    const v = recreateVariable(p, index(p), { kind: "assetType", uid: parent.uid }, before, { dataType: "INT" });
    expect(v.uid).not.toBe(before);
    expect(v.baseline).toBeUndefined();
    expect(v.dataType).toBe("INT");
    expect(v.length).toBeUndefined();
  });

  it("blocks deleting a type with children or instances", () => {
    const { p, parent, pump } = sample();
    expect(assetTypeDeletionImpact(index(p), parent.uid).blocked).toBe(true);
    expect(() => deleteAssetType(p, index(p), pump.uid)).toThrow(DomainError);
  });

  it("generates unique names case-insensitively", () => {
    expect(uniqueName("Pump", ["pump", "PUMP_2"])).toBe("Pump_3");
  });
});

describe("value, timezone and content-type checks", () => {
  it("checks data type compatibility", () => {
    expect(checkValue("INT", "2147483648")).toMatch(/range/);
    expect(checkValue("LONG", "9223372036854775807")).toBeUndefined();
    expect(checkValue("TIMESTAMP", "2018-01-01T00:00:00.00Z")).toBeUndefined();
    expect(checkValue("STRING", "abcdef", 3)).toMatch(/length/);
    expect(checkValue("BOOLEAN", "TRUE")).toBeDefined();
  });

  it("validates time zones", () => {
    expect(checkTimezone("Etc/GMT+2").ok).toBe(true);
    expect(checkTimezone("Asia/Kolkata").ok).toBe(true);
    expect(checkTimezone("Asia/Kathmandu")).toMatchObject({ ok: false, reason: "quarter-hour-offset" });
    expect(checkTimezone("Mars/Base")).toMatchObject({ ok: false, reason: "unknown" });
  });

  it("matches content types to extensions", () => {
    expect(checkContentType("manual.pdf", "application/pdf").ok).toBe(true);
    expect(checkContentType("manual.pdf", "image/png")).toMatchObject({ ok: false, reason: "mismatch" });
    expect(checkContentType("README", "text/plain")).toMatchObject({ ok: false, reason: "no-extension" });
  });
});

describe("diff", () => {
  it("matches keyed arrays by uid and reports field changes", () => {
    const changes = diffValues(
      { variables: [{ uid: "1", name: "a" }, { uid: "2", name: "b" }] },
      { variables: [{ uid: "2", name: "B" }, { uid: "3", name: "c" }] },
    );
    expect(changes).toEqual([
      { path: "variables.[uid=1]", kind: "removed", before: { uid: "1", name: "a" } },
      { path: "variables.[uid=2].name", kind: "changed", before: "b", after: "B" },
      { path: "variables.[uid=3]", kind: "added", after: { uid: "3", name: "c" } },
    ]);
  });

  it("summarises project revisions per entity", () => {
    const { p, p2 } = sample();
    const after = structuredClone(p);
    after.assets = after.assets.filter((a) => a.uid !== p2.uid);
    after.assets.find((a) => a.name === "P1")!.description = "changed";
    const d = diffProjects(p, after);
    expect(d.summary).toEqual({ added: 0, removed: 1, modified: 1 });
  });
});
