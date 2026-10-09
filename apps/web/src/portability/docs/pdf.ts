// PDF documentation (jsPDF + jspdf-autotable, loaded on demand): real text,
// headings, tables, page numbers, a contents page and PDF bookmarks.

import type { jsPDF as JsPdf } from "jspdf";
import {
  aspectTypeDocs,
  assetTypeDocs,
  changelogEntries,
  changelogTable,
  filesTable,
  formatDateTime,
  guardrailDoc,
  hierarchyDoc,
  hierarchyOmissionNote,
  inheritanceLines,
  issueTable,
  metadataTable,
  summaryData,
  type DocContext,
  type DocTable,
} from "./content";
import { enabledSections, type DocOptions, type DocSectionId } from "./options";

type AutoTable = (doc: JsPdf, options: Record<string, unknown>) => void;

async function loadPdfLibs(): Promise<{ JsPDF: typeof JsPdf; autoTable: AutoTable }> {
  const [jspdf, at] = await Promise.all([import("jspdf"), import("jspdf-autotable")]);
  const mod = at as unknown as { default?: AutoTable; autoTable?: AutoTable };
  const autoTable = mod.autoTable ?? mod.default;
  if (!autoTable) throw new Error("jspdf-autotable could not be loaded.");
  return { JsPDF: jspdf.jsPDF, autoTable };
}

// Colours of the standalone document (RGB triples).
const PRIMARY: [number, number, number] = [31, 58, 95];
const MUTED: [number, number, number] = [95, 95, 95];
const TEXT: [number, number, number] = [25, 25, 25];
const RULE: [number, number, number] = [200, 205, 212];
const HEAD_FILL: [number, number, number] = [234, 238, 244];

const MARGIN = 16;
const FOOTER = 10;

const TYPOGRAPHIC: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "‚": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "–": "-",
  "—": "-",
  "…": "...",
  "→": "->",
  "←": "<-",
  "≥": ">=",
  "≤": "<=",
  " ": " ",
  "•": "-",
  "▸": ">",
};

/**
 * The 14 standard PDF fonts only cover WinAnsi (Latin-1). Map typographic
 * punctuation to ASCII and replace characters outside Latin-1 with "?".
 */
export function pdfText(value: string): string {
  return value.replace(/[^\u0020-\u00ff\n\t]/g, (c) => TYPOGRAPHIC[c] ?? (c === "\r" ? "\r" : "?")).replace(/\r\n|\r/g, "\n");
}

class PdfWriter {
  y = MARGIN;
  readonly pageW: number;
  readonly pageH: number;
  readonly headings: { title: string; page: number; level: number }[] = [];

  constructor(
    readonly doc: JsPdf,
    readonly autoTable: AutoTable,
  ) {
    this.pageW = doc.internal.pageSize.getWidth();
    this.pageH = doc.internal.pageSize.getHeight();
  }

  get contentW(): number {
    return this.pageW - 2 * MARGIN;
  }

  get bottom(): number {
    return this.pageH - MARGIN - FOOTER;
  }

  ensure(height: number): void {
    if (this.y + height > this.bottom) this.newPage();
  }

  newPage(): void {
    this.doc.addPage();
    this.y = MARGIN;
  }

  get page(): number {
    return this.doc.getNumberOfPages();
  }

  heading(text: string, level: 1 | 2 | 3 | 4): void {
    const size = level === 1 ? 20 : level === 2 ? 15 : level === 3 ? 12 : 10;
    const before = level === 2 ? 6 : level === 3 ? 4 : 2;
    const lines = this.doc.setFont("helvetica", "bold").setFontSize(size).splitTextToSize(pdfText(text), this.contentW) as string[];
    const h = lines.length * size * 0.45 + before + 2;
    this.ensure(h + 14);
    this.y += before;
    this.doc.setTextColor(...(level <= 2 ? PRIMARY : TEXT));
    this.doc.text(lines, MARGIN, this.y + size * 0.35);
    this.y += lines.length * size * 0.45;
    if (level === 2) {
      this.doc.setDrawColor(...RULE).setLineWidth(0.3).line(MARGIN, this.y + 0.5, MARGIN + this.contentW, this.y + 0.5);
      this.y += 2;
    }
    this.y += 2;
    if (level <= 3) this.headings.push({ title: text, page: this.page, level });
  }

  paragraph(text: string, opts: { muted?: boolean; size?: number; indent?: number; bold?: boolean } = {}): void {
    const size = opts.size ?? 9;
    const indent = opts.indent ?? 0;
    this.doc.setFont("helvetica", opts.bold ? "bold" : "normal").setFontSize(size).setTextColor(...(opts.muted ? MUTED : TEXT));
    const lines = this.doc.splitTextToSize(pdfText(text), this.contentW - indent) as string[];
    const lineH = size * 0.42;
    for (const line of lines) {
      this.ensure(lineH);
      this.doc.text(line, MARGIN + indent, this.y + size * 0.32);
      this.y += lineH;
    }
    this.y += 1.5;
  }

  table(t: DocTable, opts: { kv?: boolean; columnWidths?: Record<number, number> } = {}): void {
    if (t.rows.length === 0) {
      this.paragraph("None.", { muted: true });
      return;
    }
    this.ensure(12);
    const columnStyles: Record<number, Record<string, unknown>> = {};
    if (opts.kv) columnStyles[0] = { fontStyle: "bold", cellWidth: 48, fillColor: HEAD_FILL };
    for (const [k, w] of Object.entries(opts.columnWidths ?? {})) columnStyles[Number(k)] = { ...(columnStyles[Number(k)] ?? {}), cellWidth: w };
    this.autoTable(this.doc, {
      startY: this.y,
      head: opts.kv ? undefined : [t.headers.map(pdfText)],
      body: t.rows.map((r) => r.map(pdfText)),
      theme: "grid",
      margin: { left: MARGIN, right: MARGIN, bottom: MARGIN + FOOTER, top: MARGIN },
      styles: { font: "helvetica", fontSize: 8, cellPadding: 1.4, overflow: "linebreak", textColor: TEXT, lineColor: RULE, lineWidth: 0.2 },
      headStyles: { fillColor: PRIMARY, textColor: [255, 255, 255], fontStyle: "bold" },
      alternateRowStyles: opts.kv ? undefined : { fillColor: [250, 251, 252] },
      columnStyles,
    });
    const last = (this.doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable;
    this.y = (last?.finalY ?? this.y) + 4;
  }
}

type Renderer = (w: PdfWriter, ctx: DocContext, opts: DocOptions) => void;

const SECTIONS: Record<DocSectionId, Renderer> = {
  metadata: (w, ctx) => w.table(metadataTable(ctx), { kv: true }),
  summary: (w, ctx) => {
    const s = summaryData(ctx);
    w.heading("Counts", 3);
    w.table(s.counts, { kv: true });
    w.heading("Estimated asset attributes", 3);
    w.table(s.attributes, { kv: true });
    w.paragraph(s.estimateNote, { muted: true, size: 8 });
    w.heading("Per asset type", 4);
    w.table(s.perType);
    w.heading("Validation", 3);
    w.table(s.validation, { kv: true });
    if (s.issues.length) {
      w.heading("Errors and warnings", 4);
      w.table(issueTable(s.issues), { columnWidths: { 0: 18, 1: 40 } });
      if (s.omittedIssues) w.paragraph(`${s.omittedIssues} more issues are not listed.`, { muted: true });
    } else w.paragraph("No errors or warnings.");
  },
  aspectTypes: (w, ctx) => {
    const docs = aspectTypeDocs(ctx);
    if (!docs.length) return w.paragraph("The project has no aspect types.", { muted: true });
    for (const d of docs) {
      w.heading(`${d.def.name || d.def.idSuffix} (${d.displayId})`, 3);
      w.table(d.properties, { kv: true });
      w.heading("Variables", 4);
      w.table(d.variables);
    }
  },
  assetTypes: (w, ctx) => {
    const docs = assetTypeDocs(ctx);
    if (!docs.length) return w.paragraph("The project has no asset types.", { muted: true });
    for (const d of docs) {
      w.heading(`${d.def.name || d.def.idSuffix} (${d.displayId})`, 3);
      w.table(d.properties, { kv: true });
      w.heading("Own variables", 4);
      w.table(d.ownVariables);
      w.heading("Inherited variables", 4);
      w.table(d.inheritedVariables);
      w.heading("Aspects", 4);
      w.table(d.aspects);
    }
  },
  diagram: (w, ctx) => {
    const lines = inheritanceLines(ctx);
    if (!lines.length) return w.paragraph("There are no types to draw.", { muted: true });
    w.paragraph("Inheritance tree of the project asset types (indented below their parent) with the aspects each type defines.", {
      muted: true,
    });
    for (const l of lines) {
      const label = l.kind === "project" ? `${l.name}  [${l.id}]` : `${l.name}  [${l.id}${l.kind === "external" ? ", external" : ""}]`;
      w.paragraph(`${l.depth > 0 ? "- " : ""}${label}`, { indent: l.depth * 6, bold: l.kind === "project" ? false : true, size: 9 });
      if (l.aspects.length) w.paragraph(`aspects: ${l.aspects.join(", ")}`, { indent: l.depth * 6 + 4, muted: true, size: 8 });
    }
  },
  hierarchy: (w, ctx, opts) => {
    const h = hierarchyDoc(ctx, opts.hierarchyMaxNodes, opts.hierarchyMaxDepth);
    for (const l of h.lines) {
      const hidden = l.hiddenChildren ? `  (+${l.hiddenChildren} below)` : "";
      w.paragraph(`${l.depth > 0 ? "- " : ""}${l.name}  (${l.typeName})${hidden}`, { indent: Math.min(l.depth, 20) * 5, size: 8.5 });
    }
    const note = hierarchyOmissionNote(h);
    if (note) w.paragraph(note, { muted: true });
  },
  files: (w, ctx) => (ctx.project.files.length ? w.table(filesTable(ctx)) : w.paragraph("The project has no files.", { muted: true })),
  changelog: (w, ctx) => {
    const { entries, omitted } = changelogEntries(ctx);
    w.table(changelogTable(entries), { columnWidths: { 0: 42 } });
    if (omitted) w.paragraph(`${omitted} older entries are not listed.`, { muted: true });
  },
  guardrails: (w, ctx) => {
    const g = guardrailDoc(ctx);
    w.paragraph(`Profile: ${g.profile}`);
    w.table(g.recommended);
    w.table(g.technical);
    w.heading("Notes", 4);
    for (const n of g.notes) w.paragraph(`- ${n}`);
  },
};

export async function renderPdf(ctx: DocContext, opts: DocOptions): Promise<Blob> {
  const { JsPDF, autoTable } = await loadPdfLibs();
  const doc = new JsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
  const title = `${ctx.project.name} — model documentation`;
  doc.setProperties({ title: pdfText(title), subject: "Asset model documentation", creator: "Asset Model Studio" });
  const w = new PdfWriter(doc, autoTable);
  const sections = enabledSections(opts);

  // Cover + contents (filled in at the end, when page numbers are known).
  w.heading(title, 1);
  w.paragraph(`Generated by Asset Model Studio on ${formatDateTime(ctx.generatedAt)}.`, { muted: true });
  if (ctx.project.description) w.paragraph(ctx.project.description);
  const tocY = w.y + 4;
  const tocPage = w.page;

  for (const s of sections) {
    w.newPage();
    w.heading(s.title, 2);
    SECTIONS[s.id](w, ctx, opts);
  }

  // Contents on the cover page, with links.
  doc.setPage(tocPage);
  let y = tocY;
  doc.setFont("helvetica", "bold").setFontSize(13).setTextColor(...PRIMARY).text("Contents", MARGIN, y);
  y += 7;
  doc.setFont("helvetica", "normal").setFontSize(10).setTextColor(...TEXT);
  for (const h of w.headings.filter((x) => x.level === 2)) {
    if (y > w.bottom) break;
    const label = pdfText(h.title);
    doc.textWithLink(label, MARGIN + 2, y, { pageNumber: h.page });
    doc.text(String(h.page), MARGIN + w.contentW, y, { align: "right" });
    y += 6;
  }

  // Bookmarks: sections with their entity headings.
  let parent: unknown = null;
  for (const h of w.headings) {
    if (h.level === 2) parent = doc.outline.add(null, pdfText(h.title), { pageNumber: h.page });
    else if (h.level === 3 && parent) doc.outline.add(parent, pdfText(h.title), { pageNumber: h.page });
  }

  // Footer with page numbers.
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(...MUTED);
    doc.text(pdfText(ctx.project.name), MARGIN, w.pageH - MARGIN / 2);
    doc.text(`Page ${i} of ${pages}`, w.pageW - MARGIN, w.pageH - MARGIN / 2, { align: "right" });
  }
  return doc.output("blob");
}
