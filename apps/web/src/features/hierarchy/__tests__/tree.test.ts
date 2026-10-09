import { describe, expect, it } from "vitest";
import { ROOT_ASSET_UID } from "@/domain/model";
import { asset, index, project } from "@/domain/__tests__/fixtures";
import {
  allParents,
  ancestorUids,
  buildTreeStructure,
  flattenTree,
  highlightParts,
  searchTree,
  treeKeyAction,
} from "../tree";

function sample() {
  const site = asset("Site 10", "core.basicsite");
  const site2 = asset("site 2", "core.basicsite");
  const area = asset("Area", "core.basicarea", { parentUid: site.uid, externalId: "EXT-77" });
  const pump = asset("Pump", "core.basicarea", { parentUid: area.uid });
  const p = project({ assets: [site, site2, area, pump] });
  return { p, ix: index(p), site, site2, area, pump };
}

describe("buildTreeStructure / flattenTree", () => {
  it("sorts children naturally and flattens only expanded nodes", () => {
    const { ix, site, site2, area } = sample();
    const s = buildTreeStructure(ix);
    expect(s.children.get(ROOT_ASSET_UID)).toEqual([site2.uid, site.uid]); // "site 2" < "Site 10"
    const collapsed = flattenTree(s, { isExpanded: () => false });
    expect(collapsed.map((r) => r.uid)).toEqual([ROOT_ASSET_UID]);
    const rootOnly = flattenTree(s, { isExpanded: (u) => u === ROOT_ASSET_UID });
    expect(rootOnly.map((r) => r.uid)).toEqual([ROOT_ASSET_UID, site2.uid, site.uid]);
    expect(rootOnly[2]).toMatchObject({ depth: 1, hasChildren: true, expanded: false, posInSet: 2, setSize: 2, parentRow: 0 });
    const all = flattenTree(s, { isExpanded: () => true });
    expect(all.map((r) => r.uid)).toEqual([ROOT_ASSET_UID, site2.uid, site.uid, area.uid, expect.any(String)]);
    expect(all[4]!.depth).toBe(3);
    expect(allParents(s).has(area.uid)).toBe(true);
  });

  it("shows detached and cyclic assets as extra top-level rows without looping", () => {
    const a = asset("Orphan", "core.basicarea", { parentUid: "missing" });
    const b = asset("Child of orphan", "core.basicarea", { parentUid: a.uid });
    const c1 = asset("C1", "core.basicarea");
    const c2 = asset("C2", "core.basicarea", { parentUid: c1.uid });
    c1.parentUid = c2.uid;
    const ix = index(project({ assets: [a, b, c1, c2] }));
    const s = buildTreeStructure(ix);
    expect(s.detached).toHaveLength(2);
    expect(s.detached).toContain(a.uid);
    const rows = flattenTree(s, { isExpanded: () => true });
    expect(rows.map((r) => r.uid).sort()).toEqual([ROOT_ASSET_UID, a.uid, b.uid, c1.uid, c2.uid].sort());
    expect(rows.find((r) => r.uid === b.uid)!.detached).toBe(true);
  });
});

describe("searchTree", () => {
  it("returns matches by name and externalId with their ancestors", () => {
    const { ix, site, area, pump } = sample();
    const r = searchTree(ix, "pum");
    expect([...r.matches]).toEqual([pump.uid]);
    expect([...r.ancestors].sort()).toEqual([ROOT_ASSET_UID, site.uid, area.uid].sort());
    const byExt = searchTree(ix, "ext-77");
    expect(byExt.matches.has(area.uid)).toBe(true);
    const s = buildTreeStructure(ix);
    const rows = flattenTree(s, { isExpanded: (u) => r.ancestors.has(u), visible: r.visible });
    expect(rows.map((x) => x.uid)).toEqual([ROOT_ASSET_UID, site.uid, area.uid, pump.uid]);
    expect(searchTree(ix, "  ").visible.size).toBe(0);
  });

  it("splits labels for highlighting", () => {
    expect(highlightParts("Pump pump", "PUMP")).toEqual([
      { text: "Pump", match: true },
      { text: " ", match: false },
      { text: "pump", match: true },
    ]);
    expect(highlightParts("Area", "")).toEqual([{ text: "Area", match: false }]);
  });
});

describe("treeKeyAction", () => {
  it("implements the tree keyboard model", () => {
    const { ix } = sample();
    const s = buildTreeStructure(ix);
    const rows = flattenTree(s, { isExpanded: (u) => u === ROOT_ASSET_UID });
    expect(treeKeyAction(rows, 0, "ArrowDown")).toEqual({ type: "focus", row: 1 });
    expect(treeKeyAction(rows, 0, "ArrowUp")).toEqual({ type: "focus", row: 0 });
    expect(treeKeyAction(rows, 0, "End")).toEqual({ type: "focus", row: 2 });
    expect(treeKeyAction(rows, 2, "ArrowRight")).toEqual({ type: "expand", uid: rows[2]!.uid });
    expect(treeKeyAction(rows, 0, "ArrowRight")).toEqual({ type: "focus", row: 1 });
    expect(treeKeyAction(rows, 0, "ArrowLeft")).toEqual({ type: "collapse", uid: ROOT_ASSET_UID });
    expect(treeKeyAction(rows, 2, "ArrowLeft")).toEqual({ type: "focus", row: 0 });
    expect(treeKeyAction(rows, 1, "Enter")).toEqual({ type: "select", row: 1 });
    expect(treeKeyAction(rows, 1, "x")).toEqual({ type: "none" });
    expect(treeKeyAction([], 0, "ArrowDown")).toEqual({ type: "none" });
  });

  it("lists ancestors for revealing a selection", () => {
    const { ix, site, area, pump } = sample();
    expect(ancestorUids(ix, pump.uid)).toEqual([ROOT_ASSET_UID, site.uid, area.uid]);
  });
});

describe("performance", () => {
  it("builds and flattens a 12,000 asset hierarchy quickly", () => {
    const sites = Array.from({ length: 20 }, (_, i) => asset(`Site ${i}`, "core.basicsite"));
    const assets = [...sites];
    for (const s of sites) {
      for (let j = 0; j < 30; j++) {
        const area = asset(`Area ${j}`, "core.basicarea", { parentUid: s.uid });
        assets.push(area);
        for (let k = 0; k < 19; k++) assets.push(asset(`Pump ${k}`, "core.basicarea", { parentUid: area.uid }));
      }
    }
    const ix = index(project({ assets }));
    const t0 = performance.now();
    const s = buildTreeStructure(ix);
    const rows = flattenTree(s, { isExpanded: () => true });
    const r = searchTree(ix, "pump 1");
    const elapsed = performance.now() - t0;
    expect(rows.length).toBe(assets.length + 1);
    expect(r.matches.size).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1500);
  });
});
