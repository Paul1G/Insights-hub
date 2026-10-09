// Smoke tests: the connections, explorer and audit pages render in a real
// browser against an injected fake backend (window.fetch stub, no network).

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { AllCommunityModule, ModuleRegistry } from "ag-grid-community";
import { IxApplicationContext } from "@siemens/ix-react";
import type { AuditEntry, ConnectionSummary } from "@/api/client";
import { AuditPage } from "@/pages/audit/AuditPage";
import { ConnectionsPage } from "@/pages/tenants/ConnectionsPage";
import { TenantExplorerPage } from "@/pages/tenants/TenantExplorerPage";
import { useMeStore } from "@/state/meStore";
import { asset, aspectType, assetType, variable } from "./fakes";

const sim: ConnectionSummary = {
  id: "sim1",
  name: "Playground",
  environment: "dev",
  tenant: "acme",
  authMode: "simulator",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  lastTest: { at: "2026-10-05T10:00:00Z", ok: true, latencyMs: 12 },
};
const prod: ConnectionSummary = {
  ...sim,
  id: "p1",
  name: "Production",
  environment: "prod",
  authMode: "client_credentials",
  apiBaseUrl: "https://gateway.eu1.mindsphere.io/api/assetmanagement/v3",
  tokenUrl: "https://acme.piam.eu1.mindsphere.io/oauth/token",
  clientIdHint: "abcd…wxyz",
  lastTest: undefined,
};

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
const list = (items: unknown[]) => ok({ items, totalElements: items.length, totalPages: 1, partialFailures: [], durationMs: 1 });

function fakeBackend(): typeof fetch {
  const root = asset("ROOT", { name: "acme", parentId: undefined, typeId: "core.basicenterprise", hierarchyPath: [] });
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url === "/api/connections") return ok([sim, prod]);
    if (url.startsWith("/api/audit")) {
      const e: AuditEntry = { id: "1", at: "2026-10-06T08:00:00Z", userId: "u1", kind: "upstream", method: "DELETE", path: "/assets/A", status: 204 };
      return ok([e]);
    }
    if (url.endsWith("/list")) {
      if (body.resource === "aspecttypes") return list([aspectType("acme.Engine", { variables: [variable("rpm", { dataType: "DOUBLE" })] })]);
      if (body.resource === "assettypes") return list([assetType("acme.Pump")]);
      if (body.resource === "files") return list([]);
      if (body.resource === "assets") return list([asset("A1", { name: "Pump 1", parentId: "ROOT" })]);
    }
    if (url.endsWith("/am")) {
      if (body.path === "/assets/root") return ok({ status: 200, etag: "0", body: root, attempts: 1, durationMs: 1 });
      if (body.path.startsWith("/assets/")) return ok({ status: 200, etag: "0", body: root, attempts: 1, durationMs: 1 });
    }
    return new Response(JSON.stringify({ error: `unexpected ${url}` }), { status: 400 });
  }) as typeof fetch;
}

function renderAt(path: string, element: React.ReactNode, routePath = path) {
  const router = createMemoryRouter([{ path: routePath, element }], { initialEntries: [path] });
  return render(
    <IxApplicationContext>
      <RouterProvider router={router} />
    </IxApplicationContext>,
  );
}

beforeAll(() => {
  ModuleRegistry.registerModules([AllCommunityModule]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pages", () => {
  it("connections: grouped by environment, simulator clearly labelled", async () => {
    vi.stubGlobal("fetch", fakeBackend());
    useMeStore.setState({ backendOnline: true });
    const screen = renderAt("/tenants", <ConnectionsPage />);
    await expect.element(screen.getByRole("heading", { level: 1, name: "Tenant connections" })).toBeVisible();
    await expect.element(screen.getByRole("heading", { name: "prod (1)" })).toBeVisible();
    await expect.element(screen.getByRole("heading", { name: "dev (1)" })).toBeVisible();
    await expect.element(screen.getByText("Simulated tenant — not a real Insights Hub tenant").first()).toBeVisible();
  });

  it("connections: offline message when the backend is unreachable", async () => {
    vi.stubGlobal("fetch", (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch);
    useMeStore.setState({ backendOnline: false });
    const screen = renderAt("/tenants", <ConnectionsPage />);
    await expect.element(screen.getByText("The Asset Model Studio backend is not reachable.")).toBeVisible();
  });

  it("explorer: loads the connection and the aspect types tab", async () => {
    vi.stubGlobal("fetch", fakeBackend());
    useMeStore.setState({ backendOnline: true });
    const screen = renderAt("/tenants/sim1", <TenantExplorerPage />, "/tenants/:connectionId");
    await expect.element(screen.getByRole("heading", { level: 1, name: "Playground" })).toBeVisible();
    await expect.element(screen.getByText("acme.Engine").first()).toBeVisible();
  });

  it("explorer: assets tab starts at the root and lists its children", async () => {
    vi.stubGlobal("fetch", fakeBackend());
    useMeStore.setState({ backendOnline: true });
    const screen = renderAt("/tenants/sim1", <TenantExplorerPage />, "/tenants/:connectionId");
    await screen.getByRole("tab", { name: "Assets" }).click();
    await expect.element(screen.getByRole("gridcell", { name: "Pump 1" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Create child of acme" })).toBeVisible();
  });

  it("audit: lists entries", async () => {
    vi.stubGlobal("fetch", fakeBackend());
    useMeStore.setState({ backendOnline: true });
    const screen = renderAt("/audit", <AuditPage />);
    await expect.element(screen.getByRole("heading", { level: 1, name: "Audit log" })).toBeVisible();
    // AG Grid virtualises columns, so assert on an early column and the status line.
    await expect.element(screen.getByText("1 entry loaded.")).toBeVisible();
    await expect.element(screen.getByRole("gridcell", { name: "u1" })).toBeVisible();
  });
});
