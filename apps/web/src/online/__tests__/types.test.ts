import { describe, expect, it } from "vitest";
import type { AmAssetTypeResource } from "@/api/amTypes";
import { aspectTypeCreateRequest, planAspectTypeEdit, validateAspectTypeCreate } from "../aspectTypes";
import {
  aspectDraftsFrom,
  assetTypeCreateRequest,
  newAspectDraft,
  planAssetTypeEdit,
  validateAssetTypeCreate,
  validateAssetTypeEdit,
} from "../assetTypes";
import { draftFromVariable, newVariableDraft } from "../variables";
import { aspectType, assetType, variable } from "./fakes";

const build = (steps: ReturnType<typeof planAssetTypeEdit>, etag = 1) => steps.map((s) => ({ label: s.label, ...s.build(etag) }));

describe("aspect type create", () => {
  it("PUT /aspecttypes/{tenant}.{id} with If-None-Match: *", () => {
    const form = {
      idSuffix: "Engine",
      name: "Engine",
      category: "dynamic" as const,
      description: "Engine metrics",
      variables: [{ ...newVariableDraft({ kind: "aspectType", category: "dynamic" }), name: "rpm", dataType: "DOUBLE" as const, unit: "1/min" }],
    };
    expect(validateAspectTypeCreate("acme", form, []).ok).toBe(true);
    const { id, request } = aspectTypeCreateRequest("acme", form);
    expect(id).toBe("acme.Engine");
    expect(request).toEqual({
      method: "PUT",
      path: "/aspecttypes/acme.Engine",
      ifNoneMatch: "*",
      body: {
        name: "Engine",
        category: "dynamic",
        scope: "private",
        description: "Engine metrics",
        variables: [{ name: "rpm", dataType: "DOUBLE", searchable: false, unit: "1/min", qualityCode: true }],
      },
    });
  });

  it("validates id, name uniqueness, description and at least one variable", () => {
    const res = validateAspectTypeCreate(
      "acme",
      { idSuffix: "bad id", name: "engine", category: "static", description: "it's", variables: [] },
      [aspectType("acme.Other", { name: "Engine" })],
    );
    expect(res.ok).toBe(false);
    expect(res.fields.idSuffix).toMatch(/Letters/);
    expect(res.fields.name).toMatch(/unique/);
    expect(res.fields.description).toMatch(/Single quotes/);
    expect(res.fields.variables).toMatch(/at least one/);
  });

  it("edit: description via merge patch, variables via …/variables", () => {
    const at = aspectType("acme.Engine", { description: "old", variables: [variable("rpm", { dataType: "DOUBLE" })] });
    const drafts = at.variables.map(draftFromVariable);
    drafts[0]!.unit = "rpm";
    const steps = planAspectTypeEdit(at, { description: "new", variables: drafts });
    expect(steps.map((s) => s.build(4))).toEqual([
      { method: "PATCH", path: "/aspecttypes/acme.Engine", ifMatch: 4, contentType: "application/merge-patch+json", body: { description: "new" } },
      {
        method: "PATCH",
        path: "/aspecttypes/acme.Engine/variables",
        ifMatch: 4,
        contentType: "application/merge-patch+json",
        body: { rpm: { name: "rpm", dataType: "DOUBLE", searchable: false, unit: "rpm" } },
      },
    ]);
  });

  it("core aspect types are never written", () => {
    const core = aspectType("core.contactpoint");
    expect(planAspectTypeEdit(core, { description: "x", variables: [] })).toEqual([]);
  });
});

describe("asset type create", () => {
  it("PUT with If-None-Match: *, aspects and variables", () => {
    const form = {
      idSuffix: "Pump",
      name: "Pump",
      description: "",
      parentTypeId: "core.basicasset",
      instantiable: true,
      variables: [{ ...newVariableDraft({ kind: "assetType" }), name: "serial", searchable: true }],
      aspects: [newAspectDraft("acme.Engine", "engine")],
    };
    expect(validateAssetTypeCreate("acme", form, []).ok).toBe(true);
    expect(assetTypeCreateRequest("acme", form).request).toEqual({
      method: "PUT",
      path: "/assettypes/acme.Pump",
      ifNoneMatch: "*",
      body: {
        name: "Pump",
        parentTypeId: "core.basicasset",
        instantiable: true,
        scope: "private",
        variables: [{ name: "serial", dataType: "STRING", searchable: true }],
        aspects: [{ name: "engine", aspectTypeId: "acme.Engine" }],
      },
    });
  });

  it("rejects duplicate and reserved aspect names", () => {
    const form = {
      idSuffix: "Pump",
      name: "Pump",
      description: "",
      parentTypeId: "core.basicasset",
      instantiable: true,
      variables: [],
      aspects: [newAspectDraft("acme.Engine", "aspects"), newAspectDraft("acme.Engine", "motor"), newAspectDraft("acme.Engine", "Motor")],
    };
    const res = validateAssetTypeCreate("acme", form, []);
    expect(res.aspects.map((a) => a.message)).toEqual([expect.stringMatching(/reserved/), expect.stringMatching(/unique/)]);
  });
});

describe("asset type edit plan", () => {
  const base = (): AmAssetTypeResource =>
    assetType("acme.Pump", {
      name: "Pump",
      instantiable: false,
      variables: [
        variable("serial", { length: 20 }),
        variable("level", { dataType: "INT" }),
        variable("inherited", { _links: { origin: { href: "/assettypes/acme.Base" } } }),
      ],
      aspects: [
        { name: "engine", aspectId: "A1", aspectType: aspectType("acme.Engine") },
        { name: "gear", aspectId: "A2", aspectType: aspectType("acme.Gear") },
        { name: "baseAspect", aspectId: "A9", aspectType: aspectType("acme.X"), _links: { origin: { href: "/x" } } },
      ],
    });

  it("PATCH asset type (scalars, variables array, aspects keeping aspectId) then …/variables", () => {
    const t = base();
    const drafts = t.variables.filter((v) => !v._links?.origin).map(draftFromVariable);
    drafts[0]!.length = "40"; // update → variables endpoint
    drafts[1]!.deleted = true; // removal → complete array
    const added = { ...newVariableDraft({ kind: "assetType" }), name: "maker" };
    const aspects = aspectDraftsFrom(t);
    expect(aspects.map((a) => a.name)).toEqual(["engine", "gear"]);
    aspects[0]!.name = "motor"; // rename keeps aspectId
    aspects[1]!.deleted = true;
    const edit = {
      name: "Pump v2",
      description: "Centrifugal",
      instantiable: true,
      variables: [...drafts, added],
      aspects: [...aspects, newAspectDraft("acme.Seal", "seal")],
    };
    expect(validateAssetTypeEdit(t, edit, ["inherited"], ["baseAspect"]).ok).toBe(true);
    expect(build(planAssetTypeEdit(t, edit), 7)).toEqual([
      {
        label: "Update asset type",
        method: "PATCH",
        path: "/assettypes/acme.Pump",
        ifMatch: 7,
        contentType: "application/merge-patch+json",
        body: {
          name: "Pump v2",
          description: "Centrifugal",
          instantiable: true,
          variables: [
            { name: "serial", dataType: "STRING", searchable: false, length: 20 },
            { name: "maker", dataType: "STRING", searchable: false },
          ],
          aspects: [
            { name: "motor", aspectId: "A1", aspectTypeId: "acme.Engine" },
            { name: "seal", aspectTypeId: "acme.Seal" },
          ],
        },
      },
      {
        label: "Update variables",
        method: "PATCH",
        path: "/assettypes/acme.Pump/variables",
        ifMatch: 7,
        contentType: "application/merge-patch+json",
        body: { serial: { length: 40 } },
      },
    ]);
  });

  it("recreate = remove in a first PATCH, re-add in the second", () => {
    const t = base();
    const drafts = t.variables.filter((v) => !v._links?.origin).map(draftFromVariable);
    drafts[1]!.dataType = "DOUBLE";
    drafts[1]!.recreate = true;
    const steps = build(
      planAssetTypeEdit(t, { name: t.name, description: "", instantiable: false, variables: drafts, aspects: aspectDraftsFrom(t) }),
    );
    expect(steps.map((s) => s.label)).toEqual(["Remove variables to recreate", "Update asset type"]);
    expect((steps[0]!.body as { variables: { name: string }[] }).variables.map((v) => v.name)).toEqual(["serial"]);
    expect((steps[1]!.body as { variables: { name: string; dataType: string }[] }).variables).toEqual([
      { name: "serial", dataType: "STRING", searchable: false, length: 20 },
      { name: "level", dataType: "DOUBLE", searchable: false },
    ]);
  });

  it("refuses to switch instantiable off and plans nothing without changes", () => {
    const t = { ...base(), instantiable: true };
    const drafts = t.variables.filter((v) => !v._links?.origin).map(draftFromVariable);
    const edit = { name: t.name, description: "", instantiable: false, variables: drafts, aspects: aspectDraftsFrom(t) };
    expect(validateAssetTypeEdit(t, edit).instantiable).toMatch(/cannot be made non-instantiable/);
    expect(planAssetTypeEdit(t, { ...edit, instantiable: true })).toEqual([]);
  });
});
