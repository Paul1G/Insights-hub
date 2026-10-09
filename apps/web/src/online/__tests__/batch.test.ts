import { describe, expect, it } from "vitest";
import type { AuditAppend, AuditEntry } from "@/api/client";
import {
  describeRequest,
  mapWithConcurrency,
  planDeleteAssets,
  planDeleteTypes,
  planMoveAssets,
  planSetVariable,
  recordBatchAudit,
  runBatch,
  summarize,
} from "../batch";
import { asset, FakeTransport } from "./fakes";

describe("mapWithConcurrency", () => {
  it("never exceeds the limit and keeps order", async () => {
    let inFlight = 0;
    let max = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (n) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5 + (n % 3)));
      inFlight--;
      return n * 2;
    });
    expect(max).toBe(4);
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18]);
  });
});

describe("planners", () => {
  it("delete: blocks root and assets with children", () => {
    const items = planDeleteAssets(
      [asset("R", { parentId: undefined }), asset("A"), asset("B")],
      new Map([
        ["A", { childCount: 2 }],
        ["B", { childCount: 0 }],
      ]),
    );
    expect(items.map((i) => i.blockedReason ?? describeRequest(i.request!))).toEqual([
      "The root asset cannot be deleted.",
      "Has 2 child assets; delete or move them first.",
      "DELETE /assets/B · If-Match 0",
    ]);
  });

  it("set variable: complete variables array, skips equal values and inapplicable assets", () => {
    const a = asset("A", { etag: 3, variables: [{ name: "x", value: "1" }, { name: "y", value: "2" }] });
    const b = asset("B", { variables: [{ name: "x", value: "9" }] });
    const c = asset("C", { typeId: "acme.Other" });
    const items = planSetVariable([a, b, c], { kind: "variable", name: "x" }, "9", (asset) =>
      asset.typeId === "acme.Other" ? "Type has no variable x" : undefined,
    );
    expect(items[0]!.request).toEqual({
      method: "PATCH",
      path: "/assets/A",
      ifMatch: 3,
      contentType: "application/merge-patch+json",
      body: { variables: [{ name: "x", value: "9" }, { name: "y", value: "2" }] },
    });
    expect(items[1]!.blockedReason).toBe("Already has this value.");
    expect(items[2]!.blockedReason).toBe("Type has no variable x");
  });

  it("set aspect variable: complete aspects array", () => {
    const a = asset("A", { aspects: [{ name: "np", variables: [{ name: "year", value: "1" }] }, { name: "other", variables: [] }] });
    const [item] = planSetVariable([a], { kind: "aspect", aspect: "np", name: "year" }, "2", () => undefined);
    expect(item!.request!.body).toEqual({
      aspects: [
        { name: "np", variables: [{ name: "year", value: "2" }] },
        { name: "other", variables: [] },
      ],
    });
  });

  it("move: blocks cycles and no-ops", () => {
    const target = asset("T", { hierarchyPath: [{ assetId: "R", name: "Root" }, { assetId: "A", name: "A" }] });
    const items = planMoveAssets([asset("A"), asset("B", { parentId: "T" }), asset("C", { etag: 5 })], target);
    expect(items[0]!.blockedReason).toMatch(/descendant/);
    expect(items[1]!.blockedReason).toMatch(/Already/);
    expect(items[2]!.request).toEqual({ method: "POST", path: "/assets/C/move", ifMatch: 5, body: { newParentId: "T" } });
  });

  it("types: blocked types produce no request", () => {
    const items = planDeleteTypes("aspecttypes", [
      { id: "acme.A", name: "A", etag: 1 },
      { id: "acme.B", name: "B", etag: 2, blockedReason: "in use" },
    ]);
    expect(items.map((i) => i.request?.path ?? i.blockedReason)).toEqual(["/aspecttypes/acme.A", "in use"]);
  });
});

describe("runBatch", () => {
  it("reports per-item results and a summary", async () => {
    const t = new FakeTransport((req) =>
      req.path.endsWith("/B") ? { status: 412, body: { errors: [{ message: "etag mismatch" }] } } : { status: 204, body: null },
    );
    const progress: number[] = [];
    const { results, summary } = await runBatch(
      t,
      "c1",
      [
        { key: "A", label: "A", request: { method: "DELETE", path: "/assets/A", ifMatch: 0 } },
        { key: "B", label: "B", request: { method: "DELETE", path: "/assets/B", ifMatch: 0 } },
        { key: "C", label: "C", request: null, blockedReason: "root" },
      ],
      { onResult: (_r, done) => progress.push(done) },
    );
    expect(results.map((r) => r.outcome)).toEqual(["succeeded", "failed", "skipped"]);
    expect(results[1]!.message).toMatch(/etag mismatch.*refresh and retry/);
    expect(results[1]!.status).toBe(412);
    expect(summary).toEqual({ total: 3, succeeded: 1, failed: 1, skipped: 1 });
    expect(progress.sort()).toEqual([1, 2, 3]);
    expect(t.calls).toHaveLength(2);
  });

  it("skips items after abort", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const t = new FakeTransport();
    const { summary } = await runBatch(t, "c1", [{ key: "A", label: "A", request: { method: "DELETE", path: "/x" } }], {
      signal: ctrl.signal,
    });
    expect(summary.skipped).toBe(1);
    expect(t.calls).toHaveLength(0);
  });

  it("records an audit entry with counts only", async () => {
    const appended: AuditAppend[] = [];
    await recordBatchAudit(
      { append: async (e) => (appended.push(e), { id: "1", at: "", userId: "u", kind: "action" } as AuditEntry) },
      "c1",
      "batch.delete-assets",
      "Batch delete assets",
      summarize([
        { key: "a", label: "a", outcome: "succeeded", message: "" },
        { key: "b", label: "b", outcome: "failed", message: "" },
      ]),
    );
    expect(appended).toEqual([
      {
        connectionId: "c1",
        action: "batch.delete-assets",
        summary: "Batch delete assets: 1 succeeded, 1 failed, 0 skipped (of 2).",
        details: { total: 2, succeeded: 1, failed: 1, skipped: 0 },
      },
    ]);
  });
});
