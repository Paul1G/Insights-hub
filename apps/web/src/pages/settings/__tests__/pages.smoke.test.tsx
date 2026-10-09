// Smoke tests: the global pages (projects, settings, library) render against
// the real IndexedDB and stores without throwing.

import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { MemoryRouter } from "react-router";
import { LibraryPage } from "@/pages/library/LibraryPage";
import { ProjectsPage } from "@/pages/projects/ProjectsPage";
import { db } from "@/storage/db";
import { createProject } from "@/storage/repository";
import { SettingsPage } from "../SettingsPage";

describe("global pages", () => {
  it("renders settings with profile, thresholds and technical limits", async () => {
    const screen = render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    await expect.element(screen.getByRole("heading", { level: 1, name: "Guardrails & settings" })).toBeInTheDocument();
    await expect.element(screen.getByRole("heading", { name: "Recommended thresholds" })).toBeInTheDocument();
    await expect.element(screen.getByRole("heading", { name: "Technical limits (read-only)" })).toBeInTheDocument();
    await expect.element(screen.getByText(/aspect type variables technical limit exceeded/)).toBeInTheDocument();
  });

  it("renders the core library browser", async () => {
    const screen = render(
      <MemoryRouter>
        <LibraryPage />
      </MemoryRouter>,
    );
    await expect.element(screen.getByRole("heading", { level: 1, name: "Library" })).toBeInTheDocument();
    await expect.element(screen.getByRole("heading", { level: 2, name: "BasicAsset" })).toBeInTheDocument();
    await expect.element(screen.getByText("Recommended no-cost parent")).toBeInTheDocument();
  });

  it("lists local projects from IndexedDB", async () => {
    await db.projects.clear();
    await db.projectDocs.clear();
    const screen = render(
      <MemoryRouter>
        <ProjectsPage />
      </MemoryRouter>,
    );
    await expect.element(screen.getByText("No projects yet")).toBeInTheDocument();
    await createProject("Smoke plant", "Line 1");
    await expect.element(screen.getByRole("heading", { level: 2, name: "Smoke plant" })).toBeInTheDocument();
    await expect.element(screen.getByText(/0 aspect types · 0 asset types · 0 assets · 0 files/)).toBeInTheDocument();
    await db.projects.clear();
    await db.projectDocs.clear();
  });
});
