// Editing helpers for asset instance values (static variables, static aspect
// variables, file assignments). They mutate an asset (an Immer draft) in place.

import type { AssetDef } from "@/domain/model";
import type { ResolvedAssetType } from "@/domain/resolve";

const lc = (s: string) => s.toLowerCase();

/** Set (or with `undefined`/"" clear) the override of a static variable. */
export function setVariableValue(asset: AssetDef, name: string, value: string | undefined): void {
  const idx = asset.variables.findIndex((v) => lc(v.name) === lc(name));
  if (value === undefined || value === "") {
    if (idx >= 0) asset.variables.splice(idx, 1);
    return;
  }
  if (idx >= 0) asset.variables[idx]!.value = value;
  else asset.variables.push({ name, value });
}

/** Set (or clear) a variable value of a static aspect. Empty aspects are removed. */
export function setAspectValue(asset: AssetDef, aspectName: string, variable: string, value: string | undefined): void {
  let aspect = asset.aspects.find((a) => lc(a.name) === lc(aspectName));
  if (value === undefined || value === "") {
    if (!aspect) return;
    aspect.variables = aspect.variables.filter((v) => lc(v.name) !== lc(variable));
    if (aspect.variables.length === 0) asset.aspects = asset.aspects.filter((a) => lc(a.name) !== lc(aspectName));
    return;
  }
  if (!aspect) {
    aspect = { name: aspectName, variables: [] };
    asset.aspects.push(aspect);
  }
  const v = aspect.variables.find((x) => lc(x.name) === lc(variable));
  if (v) v.value = value;
  else aspect.variables.push({ name: variable, value });
}

export function variableValue(asset: AssetDef, name: string): string | undefined {
  return asset.variables.find((v) => lc(v.name) === lc(name))?.value;
}

export function aspectValue(asset: AssetDef, aspectName: string, variable: string): string | undefined {
  return asset.aspects
    .find((a) => lc(a.name) === lc(aspectName))
    ?.variables.find((v) => lc(v.name) === lc(variable))?.value;
}

export interface DroppedValues {
  variables: string[];
  aspectValues: string[];
}

/** Values of an asset that the given type does not define (lost on a type change). */
export function valuesNotOnType(asset: AssetDef, type: ResolvedAssetType | undefined): DroppedValues {
  const vars = new Set((type?.variables ?? []).map((v) => lc(v.name)));
  const aspects = new Map(
    (type?.aspects ?? [])
      .filter((a) => a.aspectType.category === "static")
      .map((a) => [lc(a.name), new Set(a.aspectType.variables.map((v) => lc(v.name)))]),
  );
  const variables = asset.variables.filter((v) => !vars.has(lc(v.name))).map((v) => v.name);
  const aspectValues: string[] = [];
  for (const av of asset.aspects) {
    const known = aspects.get(lc(av.name));
    for (const v of av.variables) if (!known?.has(lc(v.name))) aspectValues.push(`${av.name}.${v.name}`);
  }
  return { variables, aspectValues };
}

/** Remove the values the new type does not define. */
export function retainValuesForType(asset: AssetDef, type: ResolvedAssetType | undefined): void {
  const vars = new Set((type?.variables ?? []).map((v) => lc(v.name)));
  const aspects = new Map(
    (type?.aspects ?? [])
      .filter((a) => a.aspectType.category === "static")
      .map((a) => [lc(a.name), new Set(a.aspectType.variables.map((v) => lc(v.name)))]),
  );
  asset.variables = asset.variables.filter((v) => vars.has(lc(v.name)));
  asset.aspects = asset.aspects
    .map((av) => {
      const known = aspects.get(lc(av.name));
      return known ? { ...av, variables: av.variables.filter((v) => known.has(lc(v.name))) } : null;
    })
    .filter((av): av is NonNullable<typeof av> => !!av && av.variables.length > 0);
}
