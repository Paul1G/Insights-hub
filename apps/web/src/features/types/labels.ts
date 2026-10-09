// Small display helpers shared by the type editors.

import type { Origin } from "@/domain/model";

export function originLabel(origin: Origin | undefined): string | undefined {
  if (!origin) return undefined;
  if (origin.source === "library") return `From library ${origin.ref ?? ""}`.trim();
  if (origin.source === "tenant") return `Imported from tenant${origin.ref ? ` (${origin.ref})` : ""}`;
  return `Imported${origin.ref ? ` from ${origin.ref}` : ""}`;
}

export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? singular : pluralForm}`;
}
