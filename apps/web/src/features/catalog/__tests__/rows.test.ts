import { describe, expect, it } from "vitest";
import { FakeAm } from "@/deploy/__tests__/fakeAm";
import { asset, assetType, deploy, project } from "@/deploy/__tests__/helpers";
import { correspondence } from "@/catalog/importToProject";
import { readTenant } from "@/tenant/read";
import { assetRows, assetTypeRows } from "../rows";

describe("catalog rows", () => {
  it("lists assets depth-first with paths and project status", async () => {
    const pump = assetType("Pump");
    const b = asset("B site", "core.basicsite");
    const a = asset("A site", "core.basicsite");
    const p1 = asset("P1", pump, b.uid);
    const fake = new FakeAm({ tenant: "acme" });
    await deploy(project({ assetTypes: [pump], assets: [b, a, p1] }), fake);
    const snapshot = await readTenant(fake, { tenant: "acme", includeFiles: false });

    const local = project({ assets: [asset("A site", "core.basicsite")] });
    const rows = assetRows(snapshot, correspondence(local, snapshot, undefined));
    expect(rows.map((r) => [r.path, r.depth, r.status])).toEqual([
      ["A site", 1, "in-project"],
      ["B site", 1, "not-in-project"],
      ["B site / P1", 2, "not-in-project"],
    ]);
    const types = assetTypeRows(snapshot);
    expect(types.find((t) => t.id === "acme.Pump")).toMatchObject({ origin: "tenant", instances: 1 });
    expect(types.some((t) => t.origin === "core")).toBe(true);
  });
});
