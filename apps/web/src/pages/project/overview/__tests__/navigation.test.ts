import { describe, expect, it } from "vitest";
import { entityPath, meterLevel, plannedCount } from "../navigation";

describe("overview helpers", () => {
  it("maps issue targets to editor routes", () => {
    expect(entityPath("p1", "aspectType", "a")).toBe("/p/p1/aspect-types/a");
    expect(entityPath("p1", "assetType", "t")).toBe("/p/p1/asset-types/t");
    expect(entityPath("p1", "asset", "x")).toBe("/p/p1/hierarchy/x");
    expect(entityPath("p1", "file", "f 1")).toBe("/p/p1/files?file=f%201");
    expect(entityPath("p1", "project", "p1")).toBeUndefined();
  });

  it("grades the tenant limit share and parses planned counts", () => {
    expect(meterLevel(0.2)).toBe("ok");
    expect(meterLevel(0.85)).toBe("warning");
    expect(meterLevel(1.2)).toBe("alarm");
    expect(plannedCount(12.7)).toBe(12);
    expect(plannedCount(-1)).toBeUndefined();
    expect(plannedCount(null)).toBeUndefined();
    expect(plannedCount(Number.NaN)).toBeUndefined();
  });
});
