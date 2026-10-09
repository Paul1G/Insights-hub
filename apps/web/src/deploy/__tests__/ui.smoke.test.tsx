// Smoke tests: the deployment UI renders real plans and runs (from the
// in-memory Asset Management fake) and the pages mount with a stubbed
// backend (fetch is replaced; nothing reaches the network).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { MemoryRouter } from "react-router";
import type { ConnectionSummary } from "@/api/client";
import { DeployPage } from "@/pages/project/deploy/DeployPage";
import { BackupPage } from "@/pages/backup/BackupPage";
import { CrossTenantCopyPage } from "@/pages/copy/CrossTenantCopyPage";
import { DryRunView } from "@/pages/project/deploy/components/DryRunView";
import { RunView } from "@/pages/project/deploy/components/RunView";
import { useProjectStore } from "@/state/projectStore";
import { FakeAm } from "./fakeAm";
import { analyze, aspectType, asset, assetType, deploy, project, v } from "./helpers";

const SIM: ConnectionSummary = {
  id: "c-sim",
  name: "Simulator QA",
  environment: "qa",
  tenant: "acme",
  authMode: "simulator",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function sample() {
  const at = aspectType("Metrics", { variables: [v("power")] });
  const pump = assetType("Pump", { aspects: [{ uid: "x-1", name: "metrics", aspectType: { kind: "project", uid: at.uid } }] });
  const site = asset("Plant", "core.basicsite");
  const p1 = asset("P-001", pump, site.uid);
  return project({ aspectTypes: [at], assetTypes: [pump], assets: [site, p1] });
}

describe("deployment UI", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/api/connections")) return new Response(JSON.stringify({ data: [SIM] }), { status: 200 });
        return new Response(JSON.stringify({ error: "Not available in tests" }), { status: 404 });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the dry run with phases, steps and target-only objects", async () => {
    const fake = new FakeAm();
    await fake.request({ method: "POST", path: "/assets", body: { name: "Foreign area", typeId: "core.basicarea", parentId: fake.root.assetId } });
    const plan = await analyze(sample(), fake);
    const screen = render(
      <MemoryRouter>
        <DryRunView plan={plan} onOpenStep={() => undefined} />
      </MemoryRouter>,
    );
    await expect.element(screen.getByRole("heading", { name: "Steps by phase" })).toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Pump" })).toBeInTheDocument();
    await expect.element(screen.getByText("Asset types", { exact: true }).first()).toBeInTheDocument();
    await expect.element(screen.getByText("Foreign area")).toBeInTheDocument();
    await expect.element(screen.getByRole("heading", { name: "Only in the target (1)" })).toBeInTheDocument();
  });

  it("renders a finished run with progress, report downloads and steps", async () => {
    const { run } = await deploy(sample(), new FakeAm());
    const screen = render(<RunView run={run} version={1} running={false} actions={{ onOpenStep: () => undefined, onRollback: () => undefined }} />);
    await expect.element(screen.getByText("Completed", { exact: true }).first()).toBeInTheDocument();
    await expect.element(screen.getByText(/4 of 4 steps finished/)).toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Report (Markdown)" })).toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Roll back" })).toBeInTheDocument();
  });

  it("mounts the deploy page for the open project", async () => {
    const p = sample();
    useProjectStore.setState({ project: p, loading: false, past: [], future: [], saveState: "saved" });
    const screen = render(
      <MemoryRouter>
        <DeployPage />
      </MemoryRouter>,
    );
    await expect.element(screen.getByRole("heading", { level: 1, name: "Deploy" })).toBeInTheDocument();
    await expect.element(screen.getByRole("heading", { level: 2, name: "Run history" })).toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Analyze target" })).toBeInTheDocument();
    // The stubbed connection list reaches the picker (items live in light DOM).
    await expect.poll(() => document.querySelector('ix-select-item[value="c-sim"]')).not.toBeNull();
    screen.unmount();
    useProjectStore.setState({ project: null });
  });

  it("mounts the backup page and the copy wizard", async () => {
    const backup = render(
      <MemoryRouter>
        <BackupPage />
      </MemoryRouter>,
    );
    await expect.element(backup.getByRole("heading", { level: 1, name: "Backup tenant" })).toBeInTheDocument();
    await expect.element(backup.getByRole("button", { name: "Start backup" })).toBeInTheDocument();
    backup.unmount();
    const copy = render(
      <MemoryRouter>
        <CrossTenantCopyPage />
      </MemoryRouter>,
    );
    await expect.element(copy.getByRole("heading", { level: 1, name: "Cross-tenant copy" })).toBeInTheDocument();
    await expect.element(copy.getByRole("group", { name: "Copy progress" })).toBeInTheDocument();
    await expect.element(copy.getByRole("button", { name: "Read source tenant" })).toBeInTheDocument();
  });
});
