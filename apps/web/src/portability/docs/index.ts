// Documentation generator entry point.

import { exportFileName } from "../download";
import type { DocContext } from "./content";
import { renderHtml } from "./html";
import { renderMarkdown } from "./markdown";
import { DOC_MIME, type DocFormat, type DocOptions } from "./options";

export { buildDocContext, type DocContext } from "./content";
export { renderHtml } from "./html";
export { renderMarkdown } from "./markdown";
export * from "./options";

export interface GeneratedDocument {
  blob: Blob;
  fileName: string;
}

export async function generateDocumentation(format: DocFormat, ctx: DocContext, opts: DocOptions): Promise<GeneratedDocument> {
  const fileName = exportFileName(ctx.project.name, format, "documentation", ctx.generatedAt);
  if (format === "md") return { blob: new Blob([renderMarkdown(ctx, opts)], { type: DOC_MIME.md }), fileName };
  if (format === "html") return { blob: new Blob([renderHtml(ctx, opts)], { type: DOC_MIME.html }), fileName };
  const { renderPdf } = await import("./pdf");
  return { blob: await renderPdf(ctx, opts), fileName };
}
