import { describe, expect, it } from "vitest";
import { RenamePlanError, splitVariableChanges, type Batch } from "../renames";

/** Replays batches and asserts that no batch interchanges names. */
function replay(start: string[], batches: Batch[]): string[] {
  let names = new Map(start.map((n) => [n.toLowerCase(), n]));
  for (const batch of batches) {
    const before = new Map(names);
    const keys = new Set<string>();
    for (const e of batch) {
      expect(keys.has(e.key.toLowerCase())).toBe(false);
      keys.add(e.key.toLowerCase());
      const isAdd = !before.has(e.key.toLowerCase());
      if (e.value && typeof e.value.name === "string" && e.value.name.toLowerCase() !== e.key.toLowerCase()) {
        // The new name must not be held by any variable right before the batch.
        expect(before.has(e.value.name.toLowerCase())).toBe(false);
      }
      if (isAdd) expect(before.has(e.key.toLowerCase())).toBe(false);
    }
    const next = new Map(before);
    for (const e of batch) if (before.has(e.key.toLowerCase())) next.delete(e.key.toLowerCase());
    for (const e of batch) if (e.resultName) next.set(e.resultName.toLowerCase(), e.resultName);
    names = next;
  }
  return [...names.values()].sort();
}

describe("splitVariableChanges", () => {
  it("puts independent renames and updates into one request", () => {
    const batches = splitVariableChanges([
      { uid: "1", from: "a", to: "a2" },
      { uid: "2", from: "b", to: "b", fields: { unit: "kW" } },
    ]);
    expect(batches).toHaveLength(1);
    expect(replay(["a", "b"], batches)).toEqual(["a2", "b"]);
  });

  it("splits a swap into sequential requests using a temporary name", () => {
    const batches = splitVariableChanges([
      { uid: "1", from: "a", to: "b" },
      { uid: "2", from: "b", to: "a" },
    ]);
    expect(batches.length).toBe(3);
    expect(batches.flat().some((e) => e.temporary)).toBe(true);
    expect(replay(["a", "b"], batches)).toEqual(["a", "b"]);
    // uid 1 ends up named b, uid 2 named a
    const last = new Map<string, string>();
    for (const e of batches.flat()) if (e.resultName) last.set(e.uid, e.resultName);
    expect(last.get("1")).toBe("b");
    expect(last.get("2")).toBe("a");
  });

  it("orders a chain without temporaries", () => {
    const batches = splitVariableChanges([
      { uid: "1", from: "a", to: "b" },
      { uid: "2", from: "b", to: "c" },
      { uid: "3", from: "c", to: "d" },
    ]);
    expect(batches.flat().some((e) => e.temporary)).toBe(false);
    expect(batches).toHaveLength(3);
    expect(batches[0]![0]!.key).toBe("c");
    expect(replay(["a", "b", "c"], batches)).toEqual(["b", "c", "d"]);
  });

  it("breaks a three-way cycle", () => {
    const batches = splitVariableChanges([
      { uid: "1", from: "x", to: "y" },
      { uid: "2", from: "y", to: "z" },
      { uid: "3", from: "z", to: "x" },
    ]);
    expect(replay(["x", "y", "z"], batches)).toEqual(["x", "y", "z"]);
    expect(batches.flat().filter((e) => e.temporary)).toHaveLength(1);
  });

  it("deletes first so a freed name can be reused", () => {
    const batches = splitVariableChanges([
      { uid: "old", from: "temp" },
      { uid: "new", to: "temp", fields: { dataType: "STRING", searchable: false } },
      { uid: "3", from: "p", to: "temp_old" },
    ]);
    expect(batches[0]!.some((e) => e.key === "temp" && e.value === null)).toBe(true);
    expect(batches[0]!.some((e) => e.uid === "new")).toBe(false);
    expect(replay(["temp", "p"], batches)).toEqual(["temp", "temp_old"]);
  });

  it("carries field updates on the final rename of a cycle", () => {
    const batches = splitVariableChanges([
      { uid: "1", from: "a", to: "b", fields: { unit: "m" } },
      { uid: "2", from: "b", to: "a" },
    ]);
    const of1 = batches.flat().filter((e) => e.uid === "1");
    const finalOf1 = of1[of1.length - 1]!;
    expect(finalOf1.value).toEqual({ unit: "m", name: "b" });
  });

  it("allows a case-only rename in one request", () => {
    const batches = splitVariableChanges([{ uid: "1", from: "speed", to: "Speed" }]);
    expect(batches).toHaveLength(1);
  });

  it("rejects a target name that stays in use by another variable", () => {
    expect(() => splitVariableChanges([{ uid: "1", from: "a", to: "kept" }], { otherNames: ["kept"] })).toThrow(RenamePlanError);
  });

  it("returns no batches when nothing changes", () => {
    expect(splitVariableChanges([{ uid: "1", from: "a", to: "a" }])).toEqual([]);
  });
});
