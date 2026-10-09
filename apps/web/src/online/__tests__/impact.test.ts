import { describe, expect, it } from "vitest";
import type { AmAssetResource } from "@/api/amTypes";
import {
  aspectTypeChangeImpact,
  aspectTypeDeleteImpact,
  aspectTypeUsers,
  assetDeleteImpact,
  assetTypeDeleteImpact,
  descendantAssetTypes,
  fileDeleteImpact,
  topMostTypeIds,
} from "../impact";
import { asset, aspectType, assetType, FakeTransport } from "./fakes";

const engine = aspectType("acme.Engine");
const types = [
  assetType("acme.Machine", { aspects: [{ name: "engine", aspectId: "1", aspectType: engine }] }),
  assetType("acme.Pump", {
    parentTypeId: "acme.Machine",
    aspects: [{ name: "engine", aspectId: "1", aspectType: engine, _links: { origin: { href: "/assettypes/acme.Machine" } } }],
  }),
  assetType("acme.BigPump", { parentTypeId: "acme.Pump" }),
  assetType("acme.Fan", { aspects: [{ name: "drive", aspectId: "2", aspectType: engine }] }),
];

function listByFilter(map: Record<string, AmAssetResource[]>) {
  return new FakeTransport(undefined, (req) => {
    const items = map[req.filter ?? ""] ?? [];
    return { items: items.slice(0, req.maxItems ?? items.length), totalElements: items.length };
  });
}

describe("type graph helpers", () => {
  it("finds direct users (not inherited aspects) and descendants", () => {
    expect(aspectTypeUsers("acme.engine", types).map((u) => u.type.id)).toEqual(["acme.Machine", "acme.Fan"]);
    expect(descendantAssetTypes("acme.Machine", types).map((t) => t.id)).toEqual(["acme.Pump", "acme.BigPump"]);
    expect(topMostTypeIds(["acme.Pump", "acme.Machine", "acme.Fan"], types)).toEqual(["acme.Machine", "acme.Fan"]);
  });
});

describe("delete impact", () => {
  it("aspect type: blocked while used, blocked for core", () => {
    const used = aspectTypeDeleteImpact(engine, types);
    expect(used.blocked).toBe(true);
    expect(used.groups[0]!.items.map((i) => i.id)).toEqual(["acme.Machine", "acme.Fan"]);
    expect(aspectTypeDeleteImpact(aspectType("acme.Free"), types).blocked).toBe(false);
    expect(aspectTypeDeleteImpact(aspectType("core.contactpoint"), []).blocked).toBe(true);
  });

  it("asset type: children, instances (typeId) and derived instances (hasType)", async () => {
    const t = listByFilter({
      '{"typeId":"acme.Pump"}': [asset("p1", { typeId: "acme.Pump" })],
      '{"hasType":"acme.Pump"}': [asset("p1", { typeId: "acme.Pump" }), asset("b1", { typeId: "acme.BigPump" })],
    });
    const impact = await assetTypeDeleteImpact(t, "c1", types[1]!, types);
    expect(impact.blocked).toBe(true);
    expect(impact.reasons).toEqual([
      "Has 1 child type; delete or re-parent them first.",
      "1 asset instantiate this type; delete them first.",
    ]);
    expect(impact.groups.map((g) => `${g.title}:${g.total}`)).toEqual([
      "Child asset types:1",
      "Assets of this type:1",
      "Assets of derived types:1",
    ]);
    expect(t.listCalls.every((c) => c.resource === "assets" && c.maxItems === 25)).toBe(true);
  });

  it("asset: root and assets with children are blocked", async () => {
    const t = listByFilter({ '{"parentId":"A"}': [asset("c1"), asset("c2")] });
    expect((await assetDeleteImpact(t, "c1", asset("R", { parentId: undefined }))).blocked).toBe(true);
    const a = await assetDeleteImpact(t, "c1", asset("A"));
    expect(a.blocked).toBe(true);
    expect(a.groups[0]!.total).toBe(2);
    expect((await assetDeleteImpact(t, "c1", asset("B"))).blocked).toBe(false);
  });

  it("file: blocked while assigned; lists types and verified assets", async () => {
    const t = listByFilter({
      '{"fileId":"F1"}': [
        asset("a1", { fileAssignments: [{ key: "manual", fileId: "F1" }] }),
        asset("a2", { fileAssignments: [{ key: "x", fileId: "OTHER" }] }),
      ],
    });
    const withFile = [assetType("acme.T", { fileAssignments: [{ key: "logo", fileId: "F1" }] })];
    const impact = await fileDeleteImpact(t, "c1", { id: "F1", name: "m.pdf", etag: 1, isAssigned: true }, withFile);
    expect(impact.blocked).toBe(true);
    expect(impact.groups.map((g) => g.items.map((i) => i.id))).toEqual([["acme.T"], ["a1"]]);
    const free = await fileDeleteImpact(t, "c1", { id: "F2", name: "x.txt", etag: 1, isAssigned: false }, []);
    expect(free.blocked).toBe(false);
  });
});

describe("change impact", () => {
  it("aspect type change: counts instances once per top-most using type", async () => {
    const t = listByFilter({
      '{"hasType":"acme.Machine"}': [asset("m1"), asset("p1")],
      '{"hasType":"acme.Fan"}': [asset("f1")],
    });
    const impact = await aspectTypeChangeImpact(t, "c1", "acme.Engine", types);
    expect(impact.groups[0]!.total).toBe(4); // Machine, Pump, BigPump, Fan
    expect(impact.groups[1]!.total).toBe(3);
    expect(t.listCalls.map((c) => c.filter)).toEqual(['{"hasType":"acme.Machine"}', '{"hasType":"acme.Fan"}']);
  });
});
