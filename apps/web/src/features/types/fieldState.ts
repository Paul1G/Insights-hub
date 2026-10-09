// Map validator issues of one field onto the iX form-field message props
// (invalidText / warningText / infoText + the matching state class).

import type { Issue } from "@/domain/validator";

export interface FieldMessageProps {
  invalidText?: string;
  warningText?: string;
  infoText?: string;
  className?: string;
}

export function fieldIssues(issues: Issue[], field: string): Issue[] {
  return issues.filter((i) => i.target.field === field);
}

export function fieldProps(issues: Issue[], extraError?: string): FieldMessageProps {
  const errors = [...(extraError ? [extraError] : []), ...issues.filter((i) => i.severity === "error").map((i) => i.message)];
  const warnings = issues.filter((i) => i.severity === "warning").map((i) => i.message);
  const infos = issues.filter((i) => i.severity === "info").map((i) => i.message);
  if (errors.length) return { invalidText: errors.join(" "), className: "ix-invalid" };
  if (warnings.length) return { warningText: warnings.join(" "), className: "ix-warning" };
  if (infos.length) return { infoText: infos.join(" "), className: "ix-info" };
  return {};
}
