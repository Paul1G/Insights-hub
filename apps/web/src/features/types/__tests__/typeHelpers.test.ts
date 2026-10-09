import { describe, expect, it } from "vitest";
import { asset, assetType, index, project } from "@/domain/__tests__/fixtures";
import { parentOptions, wouldCreateCycle } from "../parentOptions";
import { filterTreeRows, flattenForest, textMatch } from "../typeTree";

describe("flattenForest", () => {
  type N = { id: string; parent?: string };
  const id = (n: N) => n.id;
  const parent = (n: N) => n.parent;
  const byId = (a: N, b: N) => a.id.localeCompare(b.id);

  it("orders depth-first with levels and paths", () => {
    const rows = flattenForest<N>([{ id: "c", parent: "a" }, { id: "a" }, { id: "b", parent: "a" }, { id: "d", parent: "b" }], id, parent, byId);
    expect(rows.map((r) => `${r.id}:${r.level}`)).toEqual(["a:0", "b:1", "d:2", "c:1"]);
    expect(rows.find((r) => r.id === "d")!.path).toEqual(["a", "b"]);
    expect(rows.find((r) => r.id === "a")!.hasChildren).toBe(true);
  });

  it("keeps cyclic and orphaned items as roots", () => {
    const rows = flattenForest<N>([{ id: "x", parent: "y" }, { id: "y", parent: "x" }, { id: "o", parent: "missing" }, { id: "s", parent: "s" }], id, parent, byId);
    expect(rows.map((r) => r.id).sort()).toEqual(["o", "s", "x", "y"]);
    expect(rows.find((r) => r.id === "o")!.level).toBe(0);
  });

  it("filters to matches plus ancestors", () => {
    const rows = flattenForest<N>([{ id: "a" }, { id: "b", parent: "a" }, { id: "c", parent: "b" }, { id: "z" }], id, parent, byId);
    expect(filterTreeRows(rows, (n) => n.id === "c").map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(textMatch("PU", "Pump")).toBe(true);
    expect(textMatch("", "x")).toBe(true);
    expect(textMatch("q", "Pump", undefined)).toBe(false);
  });
});

describe("parentOptions", () => {
  const machine = assetType("Machine");
  const pump = assetType("Pump", { parent: { kind: "project", uid: machine.uid } });
  const small = assetType("SmallPump", { parent: { kind: "project", uid: pump.uid } });
  const p = project({ assetTypes: [machine, pump, small], assets: [asset("P1", pump)] });
  const ix = index(p);

  it("excludes the type itself and its descendants (cycle prevention)", () => {
    const keys = parentOptions(ix, pump.uid).map((o) => o.key);
    expect(keys).toContain(`project:${machine.uid}`);
    expect(keys).not.toContain(`project:${pump.uid}`);
    expect(keys).not.toContain(`project:${small.uid}`);
    expect(wouldCreateCycle(ix, machine.uid, { kind: "project", uid: small.uid })).toBe(true);
    expect(wouldCreateCycle(ix, small.uid, { kind: "project", uid: machine.uid })).toBe(false);
    expect(wouldCreateCycle(ix, small.uid, { kind: "core", id: "core.basicasset" })).toBe(false);
  });

  it("puts core.basicasset first and excludes root hierarchy types", () => {
    const opts = parentOptions(ix);
    expect(opts[0]!.key).toBe("core:core.basicasset");
    expect(opts[0]!.recommended).toBe(true);
    const keys = opts.map((o) => o.key);
    expect(keys).not.toContain("core:core.roothierarchy");
    expect(keys).not.toContain("core:core.basicenterprise");
    expect(keys).not.toContain("core:core.basicsubtenant");
    expect(keys).toContain("core:core.basicsite");
    const fb = opts.find((o) => o.key === "core:core.mcfb1500")!;
    expect(fb.deprecated).toBe(true);
    expect(fb.label).toMatch(/deprecated/);
    expect(opts.find((o) => o.key === "core:core.basicdevice")!.abstract).toBe(true);
  });

  it("keeps an external current parent visible", () => {
    const opts = parentOptions(ix, pump.uid, { kind: "external", id: "acme.Legacy" });
    expect(opts[0]).toMatchObject({ key: "external:acme.Legacy", group: "external" });
  });
});
