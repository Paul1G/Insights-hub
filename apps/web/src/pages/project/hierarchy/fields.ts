// Helpers mapping validator issues onto iX form field props.

import { ROOT_ASSET_UID } from "@/domain/model";
import type { ModelIndex } from "@/domain/resolve";
import { PATTERNS } from "@/domain/rules";
import type { Issue } from "@/domain/validator";

export interface FieldState {
  invalidText?: string;
  warningText?: string;
  className?: string;
}

/** First error (or warning) for a field, as iX input props. */
export function fieldState(issues: Issue[], field: string, localError?: string): FieldState {
  if (localError) return { invalidText: localError, className: "ix-invalid" };
  const own = issues.filter((i) => i.target.field === field);
  const error = own.find((i) => i.severity === "error");
  if (error) return { invalidText: error.message, className: "ix-invalid" };
  const warning = own.find((i) => i.severity === "warning");
  if (warning) return { warningText: warning.message, className: "ix-warning" };
  return {};
}

/** Parse a decimal coordinate; undefined for empty, NaN for invalid. */
export function parseCoordinate(text: string): number | undefined {
  const t = text.trim().replace(",", ".");
  if (!t) return undefined;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return Number.NaN;
  return Number(t);
}

/** File assignment key check (pattern \w+, unique per owner, case-insensitive). */
export function fileKeyError(key: string, taken: string[]): string | undefined {
  if (!key) return "Enter a key.";
  if (!PATTERNS.fileKey.test(key)) return "Keys may only contain letters, digits and _.";
  if (taken.some((k) => k.toLowerCase() === key.toLowerCase())) return "This key is already used.";
  return undefined;
}

/** "Root / Plant A / Hall 1" path label of an asset. */
export function assetPathLabel(index: ModelIndex, uid: string): string {
  const path = index.hierarchyPath(uid);
  return path.map((a) => (a.uid === ROOT_ASSET_UID ? "Root" : a.name)).join(" / ");
}
