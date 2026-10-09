/// <reference types="@vitest/browser/providers/playwright" />
import { describe, expect, it } from "vitest";
import { BUILTIN_CORE_LIBRARY, indexCoreLibrary } from "@/domain/coreLibrary";
import { createEmptyProject, type Project } from "@/domain/model";
import { ModelIndex } from "@/domain/resolve";
import { validateProject } from "@/domain/validator";
import { parseCsv } from "../csv";
import {
  TABLE_NAMES,
  applyTableImport,
  buildExportTables,
  detectTable,
  fromCsvTable,
  planTableImport,
  tableToCsv,
  type TableData,
  type TableInput,
  type TableName,
} from "../tables";
import { buildWorkbook, readWorkbook } from "../xlsx";

const core = indexCoreLibrary(BUILTIN_CORE_LIBRARY);

function sample(): Project {
  const p = createEmptyProject("Tables");
  p.aspectTypes.push(
    {
      uid: "apt-m",
      idSuffix: "Metrics",
      name: "Metrics",
      category: "dynamic",
      description: 'Live "values", with commas',
      variables: [
        { uid: "v-rpm", name: "rpm", dataType: "DOUBLE", unit: "1/min", searchable: false, qualityCode: true },
        { uid: "v-st", name: "state", dataType: "STRING", length: 32, searchable: true },
      ],
    },
    {
      uid: "apt-n",
      idSuffix: "Nameplate",
      name: "Nameplate",
      category: "static",
      variables: [
        { uid: "v-man", name: "manufacturer", dataType: "STRING", searchable: true, defaultValue: "ACME" },
        { uid: "v-yr", name: "year", dataType: "INT", searchable: false },
      ],
    },
  );
  p.assetTypes.push(
    {
      uid: "at-m",
      idSuffix: "Machine",
      name: "Machine",
      parent: { kind: "core", id: "core.basicasset" },
      instantiable: false,
      variables: [{ uid: "v-ser", name: "serial", dataType: "STRING", length: 64, searchable: true }],
      aspects: [{ uid: "asp-np", name: "nameplate", aspectType: { kind: "project", uid: "apt-n" } }],
      fileAssignments: [],
    },
    {
      uid: "at-p",
      idSuffix: "Pump",
      name: "Pump",
      description: "Centrifugal\npump",
      parent: { kind: "project", uid: "at-m" },
      instantiable: true,
      variables: [{ uid: "v-pow", name: "power", dataType: "DOUBLE", unit: "kW", searchable: false, defaultValue: "1.5" }],
      aspects: [{ uid: "asp-mt", name: "metrics", aspectType: { kind: "project", uid: "apt-m" } }],
      fileAssignments: [],
    },
  );
  p.assets.push(
    {
      uid: "a-site",
      name: "Site Nürnberg",
      type: { kind: "core", id: "core.basicsite" },
      parentUid: "root",
      twinType: "performance",
      timezone: "Europe/Berlin",
      location: { country: "Germany", locality: "Nürnberg", latitude: 49.45, longitude: 11.08 },
      variables: [],
      aspects: [],
      fileAssignments: [],
    },
    {
      uid: "a-p1",
      name: "Pump 1",
      externalId: "P-001",
      type: { kind: "project", uid: "at-p" },
      parentUid: "a-site",
      twinType: "simulation",
      variables: [
        { name: "serial", value: "007" },
        { name: "power", value: "2.25" },
      ],
      aspects: [{ name: "nameplate", variables: [{ name: "manufacturer", value: "Pumps, Inc." }, { name: "year", value: "2019" }] }],
      fileAssignments: [],
    },
    {
      uid: "a-p2",
      name: "Pump 2",
      type: { kind: "project", uid: "at-p" },
      parentUid: "a-site",
      twinType: "performance",
      variables: [],
      aspects: [],
      fileAssignments: [],
    },
  );
  return p;
}

function csvInput(tables: Record<TableName, TableData>): TableInput {
  const out: TableInput = {};
  for (const t of TABLE_NAMES) out[t] = fromCsvTable(parseCsv(tableToCsv(tables[t])));
  return out;
}

function exportOf(p: Project) {
  return buildExportTables(new ModelIndex(p, core));
}

/** Input with one cell edited: row selected by uid (or first row). */
function edit(input: TableInput, table: TableName, uid: string | null, column: string, value: string): TableInput {
  const copy = structuredClone(input);
  const t = copy[table]!;
  if (!t.headers.includes(column)) t.headers.push(column);
  const row = uid ? t.rows.find((r) => r.cells.uid === uid) : t.rows[0];
  if (!row) throw new Error(`row ${uid} not found`);
  row.cells[column] = value;
  return copy;
}

describe("spreadsheet tables", () => {
  it("exports all tables with dynamic value columns", () => {
    const t = exportOf(sample());
    expect(t.AspectTypes.rows).toHaveLength(2);
    expect(t.AspectTypeVariables.rows).toHaveLength(4);
    expect(t.AssetTypes.rows.find((r) => r.idSuffix === "Pump")?.parent).toBe("Machine");
    expect(t.AssetTypeAspects.rows.map((r) => r.aspectType).sort()).toEqual(["Metrics", "Nameplate"]);
    expect(t.Assets.headers).toEqual(expect.arrayContaining(["var:serial", "var:power", "aspect:nameplate.manufacturer", "aspect:nameplate.year"]));
    expect(t.Assets.headers).not.toContain("aspect:metrics.rpm");
    const p1 = t.Assets.rows.find((r) => r.uid === "a-p1")!;
    expect(p1.parentPath).toBe("Site Nürnberg");
    expect(p1["var:serial"]).toBe("007");
    expect(p1["aspect:nameplate.manufacturer"]).toBe("Pumps, Inc.");
  });

  it("CSV round trip is lossless (everything unchanged)", () => {
    const p = sample();
    const plan = planTableImport(p, core, csvInput(exportOf(p)));
    expect(plan.counts.error).toBe(0);
    expect(plan.counts.create).toBe(0);
    expect(plan.counts.update).toBe(0);
    expect(plan.rows.filter((r) => r.action !== "unchanged")).toEqual([]);
    expect(plan.entities.assets).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  it("XLSX round trip is lossless", async () => {
    const p = sample();
    const blob = await buildWorkbook(exportOf(p), p, new Date());
    expect(blob.size).toBeGreaterThan(1000);
    const { tables, warnings } = await readWorkbook(await blob.arrayBuffer());
    expect(warnings).toEqual([]);
    expect(Object.keys(tables).sort()).toEqual([...TABLE_NAMES].sort());
    const plan = planTableImport(p, core, tables);
    expect(plan.rows.filter((r) => r.action !== "unchanged")).toEqual([]);
    expect(plan.counts.unchanged).toBe(plan.rows.length);
  });

  it("detects updates with field diffs and applies them in one step", () => {
    const p = sample();
    let input = csvInput(exportOf(p));
    input = edit(input, "AspectTypeVariables", "v-rpm", "unit", "rpm");
    input = edit(input, "AssetTypes", "at-p", "name", "Pump XL");
    input = edit(input, "Assets", "a-p2", "description", "Standby");
    const plan = planTableImport(p, core, input);
    expect(plan.counts.update).toBe(3);
    const v = plan.rows.find((r) => r.table === "AspectTypeVariables" && r.action === "update")!;
    expect(v.changes).toEqual([{ path: "unit", kind: "changed", before: "1/min", after: "rpm" }]);
    const a = plan.rows.find((r) => r.table === "Assets" && r.action === "update")!;
    expect(a.label).toBe("Site Nürnberg / Pump 2");
    expect(a.changes[0]).toMatchObject({ path: "description", kind: "added", after: "Standby" });

    const draft = structuredClone(p);
    applyTableImport(draft, plan);
    expect(draft.aspectTypes[0]!.variables[0]!.unit).toBe("rpm");
    expect(draft.assetTypes[1]!.name).toBe("Pump XL");
    expect(draft.assets.find((x) => x.uid === "a-p2")!.description).toBe("Standby");
    // Baselines are never touched and other entities stay identical.
    expect(draft.assets.find((x) => x.uid === "a-p1")).toEqual(p.assets.find((x) => x.uid === "a-p1"));
  });

  it("creates rows without uid and matches natural keys case-insensitively", () => {
    const p = sample();
    const input: TableInput = {
      AspectTypes: fromCsvTable(parseCsv("idSuffix,name,category\nmetrics,Metrics,dynamic\nVibration,Vibration,dynamic\n")),
      AspectTypeVariables: fromCsvTable(parseCsv("aspectType,name,dataType,searchable\nVibration,rms,DOUBLE,false\nmetrics,RPM,DOUBLE,false\n")),
      Assets: fromCsvTable(
        parseCsv("parentPath,name,type\nsite nürnberg,Pump 3,Pump\nSite Nürnberg / Pump 3,Motor,core.basicasset\nsite nürnberg,PUMP 1,Pump\n"),
      ),
    };
    const plan = planTableImport(p, core, input);
    const byRow = (t: TableName, n: number) => plan.rows.find((r) => r.table === t && r.rowNumber === n)!;
    expect(byRow("AspectTypes", 2).action).toBe("unchanged");
    expect(byRow("AspectTypes", 3).action).toBe("create");
    expect(byRow("AspectTypeVariables", 2).action).toBe("create");
    expect(byRow("AspectTypeVariables", 3).action).toBe("unchanged");
    expect(byRow("Assets", 2).action).toBe("create");
    expect(byRow("Assets", 3).action).toBe("create");
    expect(byRow("Assets", 4).action).toBe("unchanged");

    const draft = structuredClone(p);
    applyTableImport(draft, plan);
    const vib = draft.aspectTypes.find((t) => t.idSuffix === "Vibration")!;
    expect(vib.variables.map((v) => v.name)).toEqual(["rms"]);
    const pump3 = draft.assets.find((a) => a.name === "Pump 3")!;
    expect(pump3.parentUid).toBe("a-site");
    expect(draft.assets.find((a) => a.name === "Motor")!.parentUid).toBe(pump3.uid);
    const result = validateProject(new ModelIndex(draft, core));
    expect(result.issues.filter((i) => i.target.label === "Pump 3" && i.severity === "error")).toEqual([]);
  });

  it("reports errors with row numbers and skips those rows", () => {
    const p = sample();
    const input: TableInput = {
      AspectTypeVariables: fromCsvTable(
        parseCsv("aspectType,name,dataType,searchable,length\nMetrics,temp,FLOAT,false,\nMetrics,flag,BOOLEAN,maybe,\nNope,x,INT,false,\nMetrics,txt,STRING,true,abc\n"),
      ),
      AssetTypes: fromCsvTable(parseCsv("idSuffix,name,parent,instantiable\nValve,Valve,UnknownParent,true\nA,A,B,true\nB,B,A,true\n")),
      Assets: fromCsvTable(parseCsv("parentPath,name,type,timezone\nNowhere,Lost,Pump,\nSite Nürnberg,Clock,Pump,Asia/Kathmandu\n")),
    };
    const plan = planTableImport(p, core, input);
    const errors = plan.rows.filter((r) => r.action === "error");
    const msg = (t: TableName, n: number) => plan.rows.find((r) => r.table === t && r.rowNumber === n)!.errors.join(" ");
    expect(msg("AspectTypeVariables", 2)).toMatch(/dataType: "FLOAT" is not one of/);
    expect(msg("AspectTypeVariables", 3)).toMatch(/searchable: expected true or false/);
    expect(msg("AspectTypeVariables", 4)).toMatch(/"Nope" is not an aspect type/);
    expect(msg("AspectTypeVariables", 5)).toMatch(/length: "abc" is not a whole number/);
    expect(msg("AssetTypes", 2)).toMatch(/UnknownParent/);
    expect(msg("AssetTypes", 3)).toMatch(/cyclic/);
    expect(msg("AssetTypes", 4)).toMatch(/cyclic/);
    expect(msg("Assets", 2)).toMatch(/parent/i);
    expect(msg("Assets", 3)).toMatch(/timezone/);
    expect(errors).toHaveLength(9);
    expect(plan.entities.aspectTypes).toEqual([]);
    expect(plan.entities.assetTypes).toEqual([]);
    expect(plan.entities.assets).toEqual([]);
  });

  it("imports value columns with type checks and clears empty cells", () => {
    const p = sample();
    let input = csvInput(exportOf(p));
    input = edit(input, "Assets", "a-p2", "var:power", "3.5");
    input = edit(input, "Assets", "a-p2", "aspect:nameplate.year", "2021");
    input = edit(input, "Assets", "a-p1", "var:serial", "");
    let plan = planTableImport(p, core, input);
    expect(plan.counts.error).toBe(0);
    const draft = structuredClone(p);
    applyTableImport(draft, plan);
    const p2 = draft.assets.find((a) => a.uid === "a-p2")!;
    expect(p2.variables).toEqual([{ name: "power", value: "3.5" }]);
    expect(p2.aspects).toEqual([{ name: "nameplate", variables: [{ name: "year", value: "2021" }] }]);
    expect(draft.assets.find((a) => a.uid === "a-p1")!.variables).toEqual([{ name: "power", value: "2.25" }]);

    input = edit(csvInput(exportOf(p)), "Assets", "a-p2", "var:power", "fast");
    input = edit(input, "Assets", "a-p1", "aspect:metrics.rpm", "12");
    input = edit(input, "Assets", "a-p1", "var:unknown", "x");
    plan = planTableImport(p, core, input);
    const rows = plan.rows.filter((r) => r.table === "Assets" && r.action === "error");
    expect(rows.map((r) => r.errors.join(" ")).join(" ")).toMatch(/Expected a number \(DOUBLE\)/);
    expect(rows.find((r) => r.label.endsWith("Pump 1"))!.errors.join(" ")).toMatch(/dynamic \(time series\) aspect|not a variable/);
  });

  it("renames carry over to values and moves follow parentPath edits", () => {
    const p = sample();
    let input = csvInput(exportOf(p));
    input = edit(input, "AssetTypeVariables", "v-ser", "name", "serialNumber");
    const plan = planTableImport(p, core, input);
    expect(plan.counts.error).toBe(0);
    const draft = structuredClone(p);
    applyTableImport(draft, plan);
    expect(draft.assets.find((a) => a.uid === "a-p1")!.variables.map((v) => v.name).sort()).toEqual(["power", "serialNumber"]);

    // Move Pump 2 under Pump 1 by editing parentPath only.
    const moved = planTableImport(p, core, edit(csvInput(exportOf(p)), "Assets", "a-p2", "parentPath", "Site Nürnberg / Pump 1"));
    const row = moved.rows.find((r) => r.table === "Assets" && r.action === "update")!;
    expect(row.changes).toEqual([{ path: "parentUid", kind: "changed", before: "a-site", after: "a-p1" }]);
  });

  it("refuses to apply a stale plan", () => {
    const p = sample();
    const plan = planTableImport(p, core, edit(csvInput(exportOf(p)), "Assets", "a-p2", "name", "Pump B"));
    const draft = structuredClone(p);
    draft.updatedAt = "2099-01-01T00:00:00.000Z";
    expect(() => applyTableImport(draft, plan)).toThrow(/changed after the preview/);
  });

  it("detects tables from headers and file names", () => {
    const t = exportOf(sample());
    for (const name of TABLE_NAMES) expect(detectTable("export.csv", t[name].headers)).toBe(name);
    expect(detectTable("plant-assets-AssetTypes-2026-10-06.csv", ["foo"])).toBe("AssetTypes");
  });
});
