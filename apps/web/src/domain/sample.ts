// The official "Modeling Assets" example from the Asset Management
// documentation (docs/reference/samples-modeling-assets.txt): a wind power
// company with WindTurbine1000 turbines in two wind farms.
//
// Deviation: the documentation's request bodies swap latitude/longitude;
// the sample uses the coordinates from its GPS table (latitude 54.008333,
// longitude 6.598333 for the North Sea farm).

import {
  ROOT_ASSET_UID,
  createEmptyProject,
  newUid,
  type AssetDef,
  type Project,
  type VariableDef,
} from "./model";

function dyn(name: string, dataType: VariableDef["dataType"], unit: string): VariableDef {
  return { uid: newUid(), name, dataType, unit, searchable: true, qualityCode: true };
}

export function createSampleProject(): Project {
  const p = createEmptyProject(
    "Wind Farm sample",
    "Official Insights Hub modelling example: WindTurbine 1000 turbines in the North Sea and Baltic Sea wind farms.",
  );
  const electrical = {
    uid: newUid(),
    idSuffix: "ElectricalMetrics",
    name: "ElectricalMetrics",
    category: "dynamic" as const,
    description: "Electrical metrics for wind turbines",
    variables: [dyn("PWR_OUT", "DOUBLE", "MW"), dyn("V_OUT", "DOUBLE", "Volt")],
  };
  const mechanical = {
    uid: newUid(),
    idSuffix: "MechanicalMetrics",
    name: "MechanicalMetrics",
    category: "dynamic" as const,
    description: "Mechanical metrics for wind turbines",
    variables: [dyn("V", "INT", "RPM"), dyn("VIB", "INT", "Hz")],
  };
  const turbine = {
    uid: newUid(),
    idSuffix: "WT1000",
    name: "WindTurbine 1000",
    description: "WindTurbine 1000 with best reliability.",
    parent: { kind: "core" as const, id: "core.basicdevice" },
    instantiable: true,
    variables: [
      {
        uid: newUid(),
        name: "InstallationDate",
        dataType: "TIMESTAMP" as const,
        searchable: true,
        defaultValue: "1970-01-01T09:00:00+00:00",
      },
    ],
    aspects: [
      { uid: newUid(), name: "ElectricalMetrics", aspectType: { kind: "project" as const, uid: electrical.uid } },
      { uid: newUid(), name: "MechanicalMetrics", aspectType: { kind: "project" as const, uid: mechanical.uid } },
    ],
    fileAssignments: [],
  };
  const farm = (name: string, latitude: number, longitude: number): AssetDef => ({
    uid: newUid(),
    name,
    description: `Wind Farm ${name}`,
    type: { kind: "core", id: "core.basicarea" },
    parentUid: ROOT_ASSET_UID,
    timezone: "Europe/Berlin",
    twinType: "performance",
    location: { latitude, longitude },
    variables: [],
    aspects: [],
    fileAssignments: [],
  });
  const north = farm("North Sea", 54.008333, 6.598333);
  const baltic = farm("Baltic Sea", 54.834, 14.068);
  const wt = (name: string, parent: AssetDef, sea: string, installed: string): AssetDef => ({
    uid: newUid(),
    name,
    description: `Wind turbine ${name.slice(2)} in ${sea}`,
    type: { kind: "project", uid: turbine.uid },
    parentUid: parent.uid,
    twinType: "performance",
    variables: [{ name: "InstallationDate", value: installed }],
    aspects: [],
    fileAssignments: [],
  });
  p.aspectTypes = [electrical, mechanical];
  p.assetTypes = [turbine];
  p.assets.push(
    north,
    baltic,
    wt("N-001", north, "North Sea", "2018-08-28T09:00:00+00:00"),
    wt("N-002", north, "North Sea", "2018-08-28T09:00:00+00:00"),
    wt("B-001", baltic, "Baltic Sea", "2018-09-12T09:00:00+00:00"),
    wt("B-002", baltic, "Baltic Sea", "2018-09-12T09:00:00+00:00"),
  );
  p.changelog = [{ at: p.createdAt, summary: "Created from the official modelling sample" }];
  return p;
}
