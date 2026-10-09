import { describe, expect, it } from "vitest";
import { produce } from "immer";
import { diffProjects } from "@/domain/diff";
import { asset, project } from "@/domain/__tests__/fixtures";
import { countByKind, filterEntities, searchChangelog } from "../compare";

describe("version compare helpers", () => {
  it("filters and counts entity changes", () => {
    const a = asset("Alpha", "core.basicsite");
    const b = asset("Beta", "core.basicsite");
    const before = project({ assets: [a, b] });
    const after = produce(before, (d) => {
      d.assets.find((x) => x.uid === a.uid)!.description = "changed";
      d.assets = d.assets.filter((x) => x.uid !== b.uid);
      d.assets.push(asset("Gamma", "core.basicarea"));
    });
    const diff = diffProjects(before, after);
    expect(countByKind(diff).asset).toBe(3);
    expect(filterEntities(diff, "all", "all", "").map((e) => e.label)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(filterEntities(diff, "asset", "removed", "").map((e) => e.label)).toEqual(["Beta"]);
    expect(filterEntities(diff, "all", "all", "gam").map((e) => e.change)).toEqual(["added"]);
    expect(filterEntities(diff, "file", "all", "")).toEqual([]);
  });

  it("searches the changelog newest first", () => {
    const entries = [
      { at: "2026-01-01T00:00:00Z", summary: "Project created" },
      { at: "2026-01-02T00:00:00Z", summary: "Add asset “Pump”", author: "jane" },
      { at: "2026-01-03T00:00:00Z", summary: "Move “Pump”" },
    ];
    expect(searchChangelog(entries, "").map((e) => e.summary)).toEqual(["Move “Pump”", "Add asset “Pump”", "Project created"]);
    expect(searchChangelog(entries, "pump")).toHaveLength(2);
    expect(searchChangelog(entries, "JANE")).toHaveLength(1);
  });
});
