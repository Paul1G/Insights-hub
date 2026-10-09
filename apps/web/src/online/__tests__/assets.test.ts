import { describe, expect, it } from "vitest";
import {
  assetBreadcrumb,
  assetCreateRequest,
  assetEditFrom,
  assetPatchBody,
  hasOwnLocation,
  locationBody,
  locationFormFrom,
  moveBlockedReason,
  validateAssetCreate,
  validateAssetEdit,
  validateLocation,
} from "../assets";
import { asset, variable } from "./fakes";

describe("asset create", () => {
  const form = {
    name: "Pump 1",
    typeId: "acme.Pump",
    externalId: "SN-1",
    description: "",
    timezone: "Europe/Berlin",
    twinType: "performance" as const,
  };

  it("POST /assets with create-only timezone and twinType", () => {
    expect(validateAssetCreate(form, new Set(["acme.Pump"]))).toEqual({
      name: undefined,
      typeId: undefined,
      externalId: undefined,
      description: undefined,
      timezone: undefined,
    });
    expect(assetCreateRequest("P1", form)).toEqual({
      method: "POST",
      path: "/assets",
      body: { name: "Pump 1", typeId: "acme.Pump", parentId: "P1", twinType: "performance", externalId: "SN-1", timezone: "Europe/Berlin" },
    });
  });

  it("rejects non-instantiable types, slashes and quarter-hour time zones", () => {
    const e = validateAssetCreate({ ...form, name: "a/b", timezone: "Asia/Kathmandu" }, new Set());
    expect(e.name).toMatch(/Slashes/);
    expect(e.typeId).toMatch(/instantiable/);
    expect(e.timezone).toMatch(/15 or 45 minutes/);
  });
});

describe("asset value edits (merge patch)", () => {
  const a = asset("A1", {
    name: "Pump",
    variables: [
      { name: "serial", value: "S-1" },
      { name: "maker", value: "ACME" },
    ],
    aspects: [{ name: "nameplate", variables: [{ name: "year", value: "2001" }] }],
  });

  it("sends only changed fields and complete arrays", () => {
    const edit = assetEditFrom(a);
    edit.variables.serial = "S-2";
    edit.variables.installed = "2020-01-01T00:00:00Z";
    edit.aspects.nameplate!.year = "2002";
    expect(assetPatchBody(a, edit)).toEqual({
      variables: [
        { name: "serial", value: "S-2" },
        { name: "maker", value: "ACME" },
        { name: "installed", value: "2020-01-01T00:00:00Z" },
      ],
      aspects: [{ name: "nameplate", variables: [{ name: "year", value: "2002" }] }],
    });
  });

  it("is three-way: concurrent changes to untouched values are kept", () => {
    const edit = assetEditFrom(a);
    edit.variables.serial = "S-2";
    const server = { ...a, description: "theirs", variables: [{ name: "serial", value: "S-1" }, { name: "maker", value: "Other" }] };
    expect(assetPatchBody(server, edit, a)).toEqual({
      variables: [
        { name: "serial", value: "S-2" },
        { name: "maker", value: "Other" },
      ],
    });
  });

  it("validates values against the definitions and forbids emptying set values", () => {
    const edit = assetEditFrom(a);
    edit.variables.serial = "";
    edit.variables.count = "x";
    const res = validateAssetEdit(
      a,
      edit,
      [variable("serial"), variable("count", { dataType: "INT" })],
      [{ name: "nameplate", category: "static", variables: [variable("year", { dataType: "INT" })] }],
    );
    expect(res.values).toEqual({
      "variable:serial": "A value that is set cannot be emptied.",
      "variable:count": "Expected a whole number (INT).",
    });
  });
});

describe("move, location, breadcrumb", () => {
  it("blocks moving below itself or a descendant", () => {
    const a = asset("A", { parentId: "R", hierarchyPath: [{ assetId: "R", name: "Root" }] });
    const child = asset("C", { parentId: "A", hierarchyPath: [{ assetId: "R", name: "Root" }, { assetId: "A", name: "A" }] });
    const other = asset("B", { parentId: "R", hierarchyPath: [{ assetId: "R", name: "Root" }] });
    expect(moveBlockedReason(a, a)).toMatch(/itself/);
    expect(moveBlockedReason(a, child)).toMatch(/descendant/);
    expect(moveBlockedReason(a, other)).toBeUndefined();
    expect(moveBlockedReason(asset("R", { parentId: undefined }), other)).toMatch(/root/);
  });

  it("location form round-trip and validation", () => {
    const f = locationFormFrom({ country: "Austria", latitude: 47.2 });
    f.longitude = "11.4";
    expect(validateLocation(f)).toEqual({});
    expect(locationBody(f)).toEqual({ country: "Austria", latitude: 47.2, longitude: 11.4 });
    expect(validateLocation({ ...f, latitude: "100" }).latitude).toMatch(/Between -90 and 90/);
    expect(validateLocation(locationFormFrom(undefined)).country).toMatch(/at least one/);
  });

  it("own vs inherited location", () => {
    expect(hasOwnLocation(asset("A1", { location: { country: "AT" }, _links: { location: { href: "/assets/A1/location" } } }))).toBe(true);
    expect(hasOwnLocation(asset("A1", { location: { country: "AT" }, _links: { location: { href: "/assets/P9/location" } } }))).toBe(false);
    expect(hasOwnLocation(asset("A1"))).toBe(false);
  });

  it("breadcrumb appends the asset to its hierarchyPath", () => {
    const a = asset("C", { name: "Child", hierarchyPath: [{ assetId: "R", name: "Root" }] });
    expect(assetBreadcrumb(a)).toEqual([
      { assetId: "R", name: "Root" },
      { assetId: "C", name: "Child" },
    ]);
  });
});
