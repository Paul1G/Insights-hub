// Smoke tests: the type editors render real data without
// throwing (real Chromium, iX web components rendered as custom elements).

import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { MemoryRouter, Route, Routes } from "react-router";
import { aspectType, asset, assetType, project, variable } from "@/domain/__tests__/fixtures";
import { useProjectStore } from "@/state/projectStore";
import { AssetTypesPage } from "../AssetTypesPage";
import { AspectTypesPage } from "../../aspect-types/AspectTypesPage";

function sample() {
  const vibration = aspectType("Vibration", {
    variables: [variable("rms", { baseline: { dataType: "DOUBLE", searchable: false } }), variable("peak")],
    baseline: { idSuffix: "Vibration", name: "Vibration", category: "dynamic" },
  });
  const machine = assetType("Machine", { instantiable: false, variables: [variable("serial", { dataType: "STRING", length: 64 })] });
  const pump = assetType("Pump", {
    parent: { kind: "project", uid: machine.uid },
    aspects: [
      { uid: "asp-1", name: "vibration", aspectType: { kind: "project", uid: vibration.uid } },
      { uid: "asp-2", name: "status", aspectType: { kind: "core", id: "core.assetstatus" } },
    ],
  });
  const p = project({ aspectTypes: [vibration], assetTypes: [machine, pump], assets: [asset("P1", pump)] });
  return { p, vibration, machine, pump };
}

// Pages read the open project (useProject); unmount before closing it.
let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
  useProjectStore.setState({ project: null, past: [], future: [] });
});

describe("type editors", () => {
  it("renders the asset type tree and the editor with inherited content", async () => {
    const { p, pump } = sample();
    useProjectStore.setState({ project: p, past: [], future: [], saveState: "saved" });
    const screen = render(
      <MemoryRouter initialEntries={[`/p/${p.id}/asset-types/${pump.uid}`]}>
        <Routes>
          <Route path="/p/:projectId/asset-types/:uid" element={<AssetTypesPage />} />
        </Routes>
      </MemoryRouter>,
    );
    unmount = screen.unmount;
    await expect.element(screen.getByRole("heading", { level: 1, name: "Asset types" })).toBeInTheDocument();
    await expect.element(screen.getByRole("heading", { level: 2, name: "Pump" })).toBeInTheDocument();
    await expect.element(screen.getByRole("heading", { name: /Inherited variables \(2\)/ })).toBeInTheDocument();
    await expect.element(screen.getByRole("heading", { name: /Own aspects \(2\)/ })).toBeInTheDocument();
    await expect.element(screen.getByRole("navigation", { name: "Inheritance chain" })).toBeInTheDocument();
  });

  it("renders the aspect type editor with locked variables and usage", async () => {
    const { p, vibration } = sample();
    useProjectStore.setState({ project: p, past: [], future: [], saveState: "saved" });
    const screen = render(
      <MemoryRouter initialEntries={[`/p/${p.id}/aspect-types/${vibration.uid}`]}>
        <Routes>
          <Route path="/p/:projectId/aspect-types/:uid" element={<AspectTypesPage />} />
        </Routes>
      </MemoryRouter>,
    );
    unmount = screen.unmount;
    await expect.element(screen.getByRole("heading", { level: 2, name: "Vibration" })).toBeInTheDocument();
    await expect.element(screen.getByRole("heading", { name: "Used by (1)" })).toBeInTheDocument();
    await expect.element(screen.getByText("Delete and recreate").first()).toBeInTheDocument();
  });
});
