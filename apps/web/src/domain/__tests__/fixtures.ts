import { BUILTIN_CORE_LIBRARY } from "../coreLibrary";
import {
  ROOT_ASSET_UID,
  createEmptyProject,
  type AspectTypeDef,
  type AssetDef,
  type AssetTypeDef,
  type Project,
  type VariableDef,
} from "../model";
import { ModelIndex } from "../resolve";

let seq = 0;
export const uid = (p = "u") => `${p}-${++seq}`;

export function variable(name: string, over: Partial<VariableDef> = {}): VariableDef {
  return { uid: uid("v"), name, dataType: "DOUBLE", searchable: false, ...over };
}

export function aspectType(name: string, over: Partial<AspectTypeDef> = {}): AspectTypeDef {
  return {
    uid: uid("apt"),
    idSuffix: name,
    name,
    category: "dynamic",
    variables: [variable("value")],
    ...over,
  };
}

export function assetType(name: string, over: Partial<AssetTypeDef> = {}): AssetTypeDef {
  return {
    uid: uid("at"),
    idSuffix: name,
    name,
    parent: { kind: "core", id: "core.basicasset" },
    instantiable: true,
    variables: [],
    aspects: [],
    fileAssignments: [],
    ...over,
  };
}

export function asset(name: string, type: AssetTypeDef | string, over: Partial<AssetDef> = {}): AssetDef {
  return {
    uid: uid("a"),
    name,
    type: typeof type === "string" ? { kind: "core", id: type } : { kind: "project", uid: type.uid },
    parentUid: ROOT_ASSET_UID,
    twinType: "performance",
    variables: [],
    aspects: [],
    fileAssignments: [],
    ...over,
  };
}

export function project(parts: Partial<Pick<Project, "aspectTypes" | "assetTypes" | "assets" | "files">> = {}): Project {
  const p = createEmptyProject("Test");
  p.aspectTypes = parts.aspectTypes ?? [];
  p.assetTypes = parts.assetTypes ?? [];
  p.assets = [...p.assets, ...(parts.assets ?? [])];
  p.files = parts.files ?? [];
  return p;
}

export function index(p: Project): ModelIndex {
  return new ModelIndex(p, BUILTIN_CORE_LIBRARY);
}
