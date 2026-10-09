// Smoke tests for the two core journeys:
//  1. offline modelling with live validation;
//  2. sample project → simulator tenant → dry run → deploy → idempotent re-analysis.

import { expect, test, type Page } from "@playwright/test";

async function createProject(page: Page, name: string) {
  await page.goto("/#/");
  await page.getByRole("button", { name: "Create project" }).first().click();
  await page.getByRole("textbox", { name: "Project name" }).fill(name);
  await page.locator("ix-modal").getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Overview & health" })).toBeVisible();
}

test("models offline with live validation", async ({ page }) => {
  await createProject(page, `Smoke ${Date.now()}`);
  await page.goto(page.url() + "/aspect-types");
  await page.getByRole("button", { name: "New aspect type" }).click();
  await page.locator("ix-modal").getByRole("textbox", { name: "Name" }).fill("PumpMetrics");
  await page.locator("ix-modal").getByRole("button", { name: "Create aspect type" }).click();
  await expect(page.getByRole("heading", { name: "PumpMetrics" })).toBeVisible();
  await expect(page.getByRole("button", { name: "0 errors", exact: true })).toBeVisible();

  // A reserved word as variable name is rejected by the validator.
  const varName = page.getByRole("textbox", { name: "Name" }).nth(1);
  await varName.fill("name");
  await varName.press("Tab");
  await expect(page.getByRole("button", { name: "1 errors", exact: true })).toBeVisible();

  // Undo restores the valid state.
  await page.getByRole("button", { name: /^Undo/ }).click();
  await expect(page.getByRole("button", { name: "0 errors", exact: true })).toBeVisible();
});

test("deploys the official sample to a simulated tenant idempotently", async ({ page, request }) => {
  const created = await request.post("/api/connections", {
    data: { name: `E2E simulator ${Date.now()}`, environment: "e2e", tenant: "e2e", auth: { mode: "simulator" } },
  });
  expect(created.ok()).toBeTruthy();
  const connection = (await created.json()).data as { id: string; name: string };

  await page.goto("/#/");
  await page.getByRole("button", { name: "Sample project" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Overview & health" })).toBeVisible();
  await page.goto(page.url() + "/deploy");

  await page.getByRole("combobox", { name: "Connection" }).click();
  await page.getByRole("option", { name: new RegExp(connection.name) }).click();
  await page.getByRole("button", { name: "Analyze target" }).click();
  await expect(page.getByText("Validation passed")).toBeVisible();
  await expect(page.getByText("9 of 9 steps shown")).toBeVisible();

  await page.getByRole("button", { name: "Execute" }).click();
  await page.locator("ix-modal").getByRole("button", { name: "Deploy now" }).click();
  await expect(page.getByText("9 of 9 steps finished")).toBeVisible();
  await expect(page.getByRole("button", { name: "Completed" }).first()).toBeVisible();

  // Re-analysing the same target maps every object: nothing new is created.
  await page.getByRole("button", { name: "Analyze target" }).click();
  await expect(page.getByText("0 of 9 steps shown")).toBeVisible();

  await request.delete(`/api/connections/${connection.id}`);
});

test("reads a tenant's existing types and assets and imports them into a project", async ({ page, request }) => {
  const created = await request.post("/api/connections", {
    data: { name: `E2E existing ${Date.now()}`, environment: "e2e", tenant: "exist", auth: { mode: "simulator" } },
  });
  const connection = (await created.json()).data as { id: string; name: string };
  const am = async (body: unknown) => (await (await request.post(`/api/connections/${connection.id}/am`, { data: body })).json()).data;
  await am({
    method: "PUT",
    path: "/assettypes/exist.Motor",
    ifNoneMatch: "*",
    body: { name: "Motor", parentTypeId: "core.basicasset", instantiable: true, scope: "private", variables: [{ name: "ratedPower", dataType: "DOUBLE" }] },
  });
  const root = await am({ method: "GET", path: "/assets/root" });
  const site = await am({ method: "POST", path: "/assets", body: { name: "Existing site", typeId: "core.basicsite", parentId: root.body.assetId } });
  await am({ method: "POST", path: "/assets", body: { name: "Existing motor", typeId: "exist.Motor", parentId: site.body.assetId } });

  await createProject(page, `Existing ${Date.now()}`);
  const base = page.url();
  await page.goto(base + "/tenant");
  await page.getByRole("combobox", { name: "Tenant connection" }).click();
  await page.getByRole("option", { name: new RegExp(connection.name) }).click();
  await page.getByRole("button", { name: "Read from tenant" }).click();
  await expect(page.getByText(/1 asset types and 0 aspect types .* and 2 assets in tenant exist/)).toBeVisible();
  await expect(page.getByRole("gridcell", { name: "exist.Motor" })).toBeVisible();

  await page.getByRole("button", { name: "Import everything not in the project" }).click();
  await page.locator("ix-modal").getByRole("button", { name: "Import 3 object(s)" }).click();
  await expect(page.getByText("Not in the project yet: 0 asset type(s), 0 aspect type(s), 0 asset(s).")).toBeVisible();

  await page.goto(base + "/hierarchy");
  await page.getByRole("button", { name: "Expand all" }).click();
  await expect(page.getByText("Existing motor")).toBeVisible();

  await request.delete(`/api/connections/${connection.id}`);
});
