import { describe, expect, it } from "vitest";
import { ApiError, UpstreamError, type AmResponse, type AuditEntry, type ConnectionSummary } from "@/api/client";
import type { AmFileMetadata } from "@/api/amTypes";
import { auditCsv, auditOperation, mergeOlder, olderCursor } from "../audit";
import {
  connectionFormFrom,
  emptyConnectionForm,
  groupByEnvironment,
  toConnectionInput,
  validateConnectionForm,
  validateHttpsUrl,
} from "../connections";
import { describeError, errorText, ROLE_HINT } from "../errors";
import { replaceFileWithEtag, validateUpload } from "../files";
import { buildFilter, matchesSearch, textCondition } from "../filters";
import { FakeTransport } from "./fakes";

const summary = (over: Partial<ConnectionSummary> = {}): ConnectionSummary => ({
  id: "c1",
  name: "Dev",
  environment: "dev",
  tenant: "acme",
  apiBaseUrl: "https://gateway.eu1.mindsphere.io/api/assetmanagement/v3",
  authMode: "client_credentials",
  tokenUrl: "https://acme.piam.eu1.mindsphere.io/oauth/token",
  clientIdHint: "abcd…wxyz",
  createdAt: "",
  updatedAt: "",
  ...over,
});

describe("connections", () => {
  it("validates tenant names (≤ 8 chars, type id prefix) and https URLs", () => {
    const f = { ...emptyConnectionForm(), name: "Dev", tenant: "toolongtenant", tokenUrl: "http://x.mindsphere.io/t" };
    const e = validateConnectionForm(f);
    expect(e.tenant).toMatch(/1–8/);
    expect(e.tokenUrl).toMatch(/https/);
    expect(e.clientId).toBeDefined();
    expect(e.clientSecret).toBeDefined();
    expect(validateHttpsUrl("https://{tenant}.piam.eu1.mindsphere.io/oauth/token")).toMatch(/placeholders/);
    expect(validateHttpsUrl("https://127.0.0.1/x")).toMatch(/IP/);
    expect(validateHttpsUrl("https://gateway.eu1.mindsphere.io/api/assetmanagement/v3")).toBeUndefined();
  });

  it("secrets are write-only: empty secret on edit keeps the stored one", () => {
    const existing = summary();
    const form = { ...connectionFormFrom(existing), clientId: "id-1" };
    expect(form.clientSecret).toBe("");
    expect(validateConnectionForm(form, existing)).toEqual({});
    const input = toConnectionInput(form);
    expect(input.auth).toEqual({ mode: "client_credentials", tokenUrl: existing.tokenUrl, clientId: "id-1" });
    expect(JSON.stringify(input)).not.toMatch(/clientSecret/);
    // switching the auth mode requires new credentials
    expect(validateConnectionForm({ ...form, mode: "bearer" }, existing).token).toBeDefined();
  });

  it("simulator needs no URL or credentials", () => {
    const form = { ...emptyConnectionForm(), name: "Sim", tenant: "sim", mode: "simulator" as const };
    expect(validateConnectionForm(form)).toEqual({});
    expect(toConnectionInput(form)).toEqual({ name: "Sim", environment: "dev", tenant: "sim", auth: { mode: "simulator" } });
  });

  it("groups by environment, well-known environments first", () => {
    const groups = groupByEnvironment([
      summary({ id: "1", name: "b", environment: "dev" }),
      summary({ id: "2", name: "a", environment: "Prod" }),
      summary({ id: "3", name: "c", environment: "custom" }),
      summary({ id: "4", name: "a", environment: "dev" }),
    ]);
    expect(groups.map((g) => `${g.environment}:${g.connections.map((c) => c.id).join("")}`)).toEqual(["Prod:2", "dev:41", "custom:3"]);
  });
});

describe("errors", () => {
  it("explains 401/403 with the Asset Management role", () => {
    const info = describeError(new UpstreamError(403, { errors: [{ message: "Forbidden", code: "x" }] }));
    expect(info.messages).toEqual(["Forbidden — x"]);
    expect(info.hint).toBe(ROLE_HINT);
  });

  it("flags the backend as offline", () => {
    const info = describeError(new ApiError(0, "The Asset Model Studio backend is not reachable (offline?)."));
    expect(info.offline).toBe(true);
    expect(errorText(new UpstreamError(400, { errors: [{ message: "bad" }] }))).toBe("HTTP 400: bad");
  });
});

describe("filters", () => {
  it("builds JSON filters and drops empty conditions", () => {
    expect(buildFilter({ parentId: "abc" })).toBe('{"parentId":"abc"}');
    expect(buildFilter({ name: textCondition("contains", " Pump "), typeId: undefined, hasType: "" })).toBe(
      '{"name":{"contains":"Pump"}}',
    );
    expect(buildFilter({ name: textCondition("contains", "") })).toBeUndefined();
  });

  it("client search matches every term", () => {
    expect(matchesSearch("pump acme", "Pump 1", "acme.Pump")).toBe(true);
    expect(matchesSearch("pump fan", "Pump 1", "acme.Pump")).toBe(false);
    expect(matchesSearch("", "x")).toBe(true);
  });
});

describe("files", () => {
  it("validates size, extension/content type and name", () => {
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.pdf", { type: "application/pdf" });
    expect(validateUpload({ name: "big.pdf", description: "", scope: "private", file: big }).file).toMatch(/maximum file size/);
    const noExt = new File(["x"], "README", { type: "" });
    expect(validateUpload({ name: "README", description: "", scope: "private", file: noExt }).file).toMatch(/extension/);
    const ok = new File(["x"], "manual.txt", { type: "text/plain" });
    expect(validateUpload({ name: "my manual.txt", description: "", scope: "private", file: ok }).name).toMatch(/No spaces/);
    expect(validateUpload({ name: "manual.txt", description: "", scope: "private", file: ok })).toEqual({
      name: undefined,
    });
  });

  it("replace retries on the fresh etag after 412 when overwriting", async () => {
    const meta = { id: "F", name: "a.txt", etag: 1 };
    const t = new FakeTransport(() => ({ status: 200, body: { ...meta, etag: 2 }, etag: "2" }));
    const sent: (string | number)[] = [];
    const ft = {
      replace: async (_c: string, _id: string, ifMatch: string | number): Promise<AmResponse<AmFileMetadata>> => {
        sent.push(ifMatch);
        return String(ifMatch) === "2"
          ? { status: 200, body: { ...meta, etag: 3 }, attempts: 1, durationMs: 1 }
          : { status: 412, body: meta, attempts: 1, durationMs: 1 };
      },
    };
    const input = { name: "a.txt", fileName: "a.txt", mimeType: "text/plain", contentBase64: "eA==" };
    const res = await replaceFileWithEtag(ft, t, "c1", meta, input, async () => "overwrite");
    expect(res).toEqual({ kind: "done", file: { ...meta, etag: 3 } });
    expect(sent).toEqual([1, "2"]);
  });
});

describe("audit", () => {
  const e = (id: string, at: string, over: Partial<AuditEntry> = {}): AuditEntry => ({ id, at, userId: "u1", kind: "upstream", ...over });

  it("pages with the oldest timestamp and de-duplicates", () => {
    const first = [e("3", "2026-10-06T10:00:00Z"), e("2", "2026-10-06T09:00:00Z")];
    expect(olderCursor(first)).toBe("2026-10-06T09:00:00Z");
    const merged = mergeOlder(first, [e("2", "2026-10-06T09:00:00Z"), e("1", "2026-10-06T08:00:00Z")]);
    expect(merged.map((x) => x.id)).toEqual(["3", "2", "1"]);
  });

  it("exports CSV and neutralises formulas", () => {
    const csv = auditCsv([
      e("1", "2026-10-06T08:00:00Z", { method: "DELETE", path: "/assets/A", status: 204, durationMs: 12, attempts: 1 }),
      e("2", "2026-10-06T08:01:00Z", { kind: "action", action: "batch.delete-assets", summary: "=HYPERLINK(1)" }),
    ]);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("time,user,connection,connectionId,kind,method,path,action,status,durationMs,attempts,summary,error");
    expect(lines[1]).toBe("2026-10-06T08:00:00Z,u1,,,upstream,DELETE,/assets/A,,204,12,1,,");
    expect(lines[2]).toContain("'=HYPERLINK(1)");
    expect(auditOperation(e("x", "", { action: "deploy" }))).toBe("deploy");
  });
});
