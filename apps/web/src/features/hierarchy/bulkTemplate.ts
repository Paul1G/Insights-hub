// Bulk creation from a name template ("Pump {n:3}" × count under one parent).

import { expandNameTemplate, type BulkAssetRow } from "@/domain/ops";
import type { TypeRef } from "@/domain/model";
import type { ModelIndex } from "@/domain/resolve";
import { assetNameError, siblingNameSet } from "./types";

/** Maximum number of assets created per bulk run. */
export const BULK_MAX = 5000;

export interface TemplateInput {
  template: string;
  count: number;
  start: number;
  type: TypeRef | undefined;
  parentUid: string;
}

export interface TemplatePlan {
  rows: BulkAssetRow[];
  /** The generated names (also when there are errors, for the preview). */
  names: string[];
  errors: string[];
}

const PREVIEW_DUPLICATES = 5;

export function planTemplate(index: ModelIndex, input: TemplateInput): TemplatePlan {
  const errors: string[] = [];
  const { template, count, start, type, parentUid } = input;
  if (!template.trim()) errors.push("Enter a name template.");
  if (!Number.isInteger(count) || count < 1) errors.push("Count must be a whole number of at least 1.");
  else if (count > BULK_MAX) errors.push(`At most ${BULK_MAX.toLocaleString()} assets can be created per run.`);
  if (!Number.isInteger(start) || start < 0) errors.push("Start number must be a whole number of 0 or more.");
  if (!type) errors.push("Choose an asset type.");
  if (!index.assets.has(parentUid)) errors.push("Choose a parent asset.");

  const canExpand = template.trim() && Number.isInteger(count) && count >= 1 && count <= BULK_MAX && Number.isInteger(start) && start >= 0;
  const names = canExpand ? expandNameTemplate(template.trim(), count, start) : [];

  if (names.length) {
    const invalid = names.map((n) => ({ n, e: assetNameError(n) })).find((x) => x.e);
    if (invalid) errors.push(`"${invalid.n}": ${invalid.e}`);
    const taken = index.assets.has(parentUid) ? siblingNameSet(index, parentUid) : new Set<string>();
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const n of names) {
      const key = n.toLowerCase();
      if (taken.has(key) || seen.has(key)) dupes.push(n);
      seen.add(key);
    }
    if (dupes.length) {
      const shown = dupes.slice(0, PREVIEW_DUPLICATES).map((d) => `"${d}"`).join(", ");
      const more = dupes.length > PREVIEW_DUPLICATES ? ` and ${dupes.length - PREVIEW_DUPLICATES} more` : "";
      errors.push(`${dupes.length} name(s) already exist under this parent (case-insensitive): ${shown}${more}.`);
    }
  }

  const rows: BulkAssetRow[] = errors.length || !type ? [] : names.map((name) => ({ name, type, parentUid }));
  return { rows, names, errors };
}
