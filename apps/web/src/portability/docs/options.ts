// Documentation generator options: formats, toggleable sections, caps.

export const DOC_FORMATS = ["md", "html", "pdf"] as const;
export type DocFormat = (typeof DOC_FORMATS)[number];

export const DOC_FORMAT_LABELS: Record<DocFormat, string> = {
  md: "Markdown (.md)",
  html: "HTML (single file, works offline)",
  pdf: "PDF",
};

export const DOC_MIME: Record<DocFormat, string> = {
  md: "text/markdown;charset=utf-8",
  html: "text/html;charset=utf-8",
  pdf: "application/pdf",
};

export const DOC_SECTIONS = [
  { id: "metadata", title: "Project", description: "Name, description, dates and generation time." },
  { id: "summary", title: "Summary", description: "Counts, estimated asset attributes per type and the validation summary." },
  { id: "aspectTypes", title: "Aspect types", description: "Category, description and variables of every aspect type." },
  { id: "assetTypes", title: "Asset types", description: "Ids, inheritance, variables (own and inherited), aspects and attributes per asset." },
  { id: "diagram", title: "Relationship diagram", description: "Inheritance tree and aspect type usage." },
  { id: "hierarchy", title: "Asset hierarchy", description: "The asset tree with type names (capped for very large trees)." },
  { id: "files", title: "Files", description: "Files of the project and where they are assigned." },
  { id: "changelog", title: "Change log", description: "The project's change history." },
  { id: "guardrails", title: "Guardrails", description: "Active guardrail profile, thresholds, technical limits and notes." },
] as const;

export type DocSectionId = (typeof DOC_SECTIONS)[number]["id"];

/** Anchor ids of the sections in HTML. */
export const SECTION_ANCHORS: Record<DocSectionId, string> = {
  metadata: "project",
  summary: "summary",
  aspectTypes: "aspect-types",
  assetTypes: "asset-types",
  diagram: "diagram",
  hierarchy: "hierarchy",
  files: "files",
  changelog: "change-log",
  guardrails: "guardrails",
};

export interface DocOptions {
  sections: Record<DocSectionId, boolean>;
  /** Maximum number of assets listed in the hierarchy tree. */
  hierarchyMaxNodes: number;
  /** Maximum depth (levels below the tenant root) listed in the hierarchy tree. */
  hierarchyMaxDepth: number;
}

export const DEFAULT_HIERARCHY_MAX_NODES = 2000;
export const DEFAULT_HIERARCHY_MAX_DEPTH = 20;

export function defaultDocOptions(): DocOptions {
  return {
    sections: Object.fromEntries(DOC_SECTIONS.map((s) => [s.id, true])) as Record<DocSectionId, boolean>,
    hierarchyMaxNodes: DEFAULT_HIERARCHY_MAX_NODES,
    hierarchyMaxDepth: DEFAULT_HIERARCHY_MAX_DEPTH,
  };
}

export function enabledSections(opts: DocOptions): (typeof DOC_SECTIONS)[number][] {
  return DOC_SECTIONS.filter((s) => opts.sections[s.id]);
}
