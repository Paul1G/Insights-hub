// Single-file HTML documentation: embedded print-friendly CSS, table of
// contents, inline SVG diagram — no external resources, works offline.

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
  issueTable,
  metadataTable,
  summaryData,
  type DocContext,
  type DocTable,
  type HierarchyLine,
} from "./content";
import { buildDiagramGraph, diagramLegendHtml, layoutDiagram, renderSvg } from "./diagram";
import { escapeHtml as e } from "./escape";
import { SECTION_ANCHORS, enabledSections, type DocOptions, type DocSectionId } from "./options";

// Print CSS of the standalone document (its own colours, not the app theme).
const CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; font-family: "Segoe UI", Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.45; color: rgb(25, 25, 25); background: rgb(255, 255, 255); }
.doc { max-width: 1180px; margin: 0 auto; padding: 32px 40px 64px; }
header.cover { border-bottom: 3px solid rgb(31, 58, 95); padding-bottom: 16px; margin-bottom: 24px; }
h1 { font-size: 28px; margin: 0 0 6px; color: rgb(31, 58, 95); overflow-wrap: anywhere; }
h2 { font-size: 21px; margin: 40px 0 12px; padding-bottom: 4px; border-bottom: 1px solid rgb(200, 205, 212); color: rgb(31, 58, 95); }
h3 { font-size: 17px; margin: 28px 0 8px; overflow-wrap: anywhere; }
h4 { font-size: 14px; margin: 16px 0 6px; color: rgb(70, 70, 70); }
p, li { overflow-wrap: anywhere; }
.muted { color: rgb(95, 95, 95); }
.lead { font-size: 15px; }
nav.toc { background: rgb(244, 246, 249); border: 1px solid rgb(220, 224, 230); border-radius: 6px; padding: 12px 20px; margin: 16px 0 8px; }
nav.toc h2 { margin: 0 0 6px; font-size: 16px; border: 0; padding: 0; }
nav.toc ol { margin: 0; padding-left: 22px; columns: 2; }
nav.toc a, a { color: rgb(20, 80, 160); }
table { border-collapse: collapse; width: 100%; margin: 6px 0 14px; font-size: 13px; }
th, td { border: 1px solid rgb(214, 218, 224); padding: 5px 8px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
th { background: rgb(234, 238, 244); font-weight: 600; }
tr:nth-child(even) td { background: rgb(250, 251, 252); }
table.kv th { width: 28%; }
code { font-family: Consolas, "Courier New", monospace; font-size: 12.5px; background: rgb(242, 244, 247); padding: 0 3px; border-radius: 3px; }
.sev-error { color: rgb(178, 20, 30); font-weight: 600; }
.sev-warning { color: rgb(150, 90, 0); font-weight: 600; }
.sev-info { color: rgb(30, 90, 160); }
.entity { border-left: 3px solid rgb(200, 210, 225); padding-left: 14px; margin-top: 18px; }
.diagram-wrap { overflow: auto; border: 1px solid rgb(220, 224, 230); border-radius: 6px; max-height: 80vh; background: rgb(255, 255, 255); }
.diagram-wrap svg { display: block; }
ul.legend { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 6px 22px; margin: 8px 0; }
ul.legend li { display: flex; align-items: center; gap: 6px; }
ul.tree, ul.tree ul { list-style: none; margin: 0; padding-left: 18px; }
ul.tree { padding-left: 0; }
ul.tree li { margin: 1px 0; }
ul.tree li::before { content: "▸ "; color: rgb(150, 150, 150); }
.type { color: rgb(95, 95, 95); font-size: 12.5px; }
footer { margin-top: 48px; color: rgb(110, 110, 110); font-size: 12px; border-top: 1px solid rgb(220, 224, 230); padding-top: 8px; }
@media print {
  body { font-size: 11pt; }
  .doc { max-width: none; padding: 0; }
  h2 { break-before: page; }
  nav.toc + section h2, header.cover + section h2 { break-before: auto; }
  h2, h3, h4 { break-after: avoid; }
  tr, .entity table { break-inside: avoid; }
  .diagram-wrap { overflow: visible; max-height: none; border: 0; }
  .diagram-wrap svg { width: 100%; height: auto; }
  a { color: inherit; text-decoration: none; }
  nav.toc { break-after: page; }
}
@page { margin: 16mm 14mm; }
`;

function table(t: DocTable, cls?: string): string {
  if (t.rows.length === 0) return `<p class="muted">None.</p>`;
  const head = `<thead><tr>${t.headers.map((h) => `<th scope="col">${e(h)}</th>`).join("")}</tr></thead>`;
  const body = t.rows.map((r) => `<tr>${r.map((c) => `<td>${e(c)}</td>`).join("")}</tr>`).join("");
  return `<table${cls ? ` class="${cls}"` : ""}>${head}<tbody>${body}</tbody></table>`;
}

/** Two-column property table with row headers. */
function kv(t: DocTable): string {
  const body = t.rows.map((r) => `<tr><th scope="row">${e(r[0] ?? "")}</th><td>${e(r[1] ?? "")}</td></tr>`).join("");
  return `<table class="kv"><tbody>${body}</tbody></table>`;
}

function issuesTable(t: DocTable): string {
  if (t.rows.length === 0) return "";
  const head = `<thead><tr>${t.headers.map((h) => `<th scope="col">${e(h)}</th>`).join("")}</tr></thead>`;
  const body = t.rows
    .map(([sev, ...rest]) => `<tr><td class="sev-${e(sev ?? "")}">${e(sev ?? "")}</td>${rest.map((c) => `<td>${e(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<table>${head}<tbody>${body}</tbody></table>`;
}

function tree(lines: HierarchyLine[]): string {
  // Pre-order lines with depths → nested lists.
  let html = "";
  let depth = -1;
  for (const l of lines) {
    if (l.depth > depth) {
      for (let d = depth; d < l.depth; d++) html += d === -1 ? `<ul class="tree">` : "<ul>";
    } else {
      html += "</li>";
      for (let d = depth; d > l.depth; d--) html += "</ul></li>";
    }
    depth = l.depth;
    const hidden = l.hiddenChildren ? ` <span class="muted">(+${l.hiddenChildren} below)</span>` : "";
    html += `<li><strong>${e(l.name)}</strong> <span class="type">${e(l.typeName)}</span>${hidden}`;
  }
  if (depth >= 0) {
    html += "</li>";
    for (let d = depth; d > 0; d--) html += "</ul></li>";
    html += "</ul>";
  }
  return html;
}

type Renderer = (ctx: DocContext, opts: DocOptions) => string;

const SECTIONS: Record<DocSectionId, Renderer> = {
  metadata: (ctx) => kv(metadataTable(ctx)),
  summary: (ctx) => {
    const s = summaryData(ctx);
    return [
      `<h3>Counts</h3>`,
      kv(s.counts),
      `<h3>Estimated asset attributes</h3>`,
      kv(s.attributes),
      `<p class="muted">${e(s.estimateNote)}</p>`,
      `<h4>Per asset type</h4>`,
      table(s.perType),
      `<h3>Validation</h3>`,
      kv(s.validation),
      s.issues.length ? `<h4>Errors and warnings</h4>${issuesTable(issueTable(s.issues))}` : `<p>No errors or warnings.</p>`,
      s.omittedIssues ? `<p class="muted">${s.omittedIssues} more issues are not listed.</p>` : "",
    ].join("\n");
  },
  aspectTypes: (ctx) => {
    const docs = aspectTypeDocs(ctx);
    if (!docs.length) return `<p class="muted">The project has no aspect types.</p>`;
    return docs
      .map(
        (d, i) =>
          `<div class="entity" id="aspect-type-${i + 1}"><h3>${e(d.def.name || d.def.idSuffix)} <code>${e(d.displayId)}</code></h3>${kv(d.properties)}<h4>Variables</h4>${table(d.variables)}</div>`,
      )
      .join("\n");
  },
  assetTypes: (ctx) => {
    const docs = assetTypeDocs(ctx);
    if (!docs.length) return `<p class="muted">The project has no asset types.</p>`;
    return docs
      .map(
        (d, i) =>
          `<div class="entity" id="asset-type-${i + 1}"><h3>${e(d.def.name || d.def.idSuffix)} <code>${e(d.displayId)}</code></h3>${kv(d.properties)}` +
          `<h4>Own variables</h4>${table(d.ownVariables)}<h4>Inherited variables</h4>${table(d.inheritedVariables)}<h4>Aspects</h4>${table(d.aspects)}</div>`,
      )
      .join("\n");
  },
  diagram: (ctx) => {
    const graph = buildDiagramGraph(ctx);
    if (!graph.nodes.length) return `<p class="muted">There are no types to draw.</p>`;
    const layout = layoutDiagram(graph);
    return `${diagramLegendHtml()}<div class="diagram-wrap">${renderSvg(layout, `Relationship diagram of ${ctx.project.name}`)}</div>`;
  },
  hierarchy: (ctx, opts) => {
    const h = hierarchyDoc(ctx, opts.hierarchyMaxNodes, opts.hierarchyMaxDepth);
    const note = hierarchyOmissionNote(h);
    return `${tree(h.lines)}${note ? `<p class="muted">${e(note)}</p>` : ""}`;
  },
  files: (ctx) => (ctx.project.files.length ? table(filesTable(ctx)) : `<p class="muted">The project has no files.</p>`),
  changelog: (ctx) => {
    const { entries, omitted } = changelogEntries(ctx);
    return `${table(changelogTable(entries))}${omitted ? `<p class="muted">${omitted} older entries are not listed.</p>` : ""}`;
  },
  guardrails: (ctx) => {
    const g = guardrailDoc(ctx);
    return [
      `<p><strong>Profile:</strong> ${e(g.profile)}</p>`,
      table(g.recommended),
      table(g.technical),
      `<h3>Notes</h3><ul>${g.notes.map((n) => `<li>${e(n)}</li>`).join("")}</ul>`,
    ].join("\n");
  },
};

export function renderHtml(ctx: DocContext, opts: DocOptions): string {
  const sections = enabledSections(opts);
  const title = `${ctx.project.name} — model documentation`;
  const toc =
    sections.length > 1
      ? `<nav class="toc" aria-labelledby="toc-title"><h2 id="toc-title">Contents</h2><ol>${sections
          .map((s) => `<li><a href="#${SECTION_ANCHORS[s.id]}">${e(s.title)}</a></li>`)
          .join("")}</ol></nav>`
      : "";
  const body = sections
    .map((s) => `<section id="${SECTION_ANCHORS[s.id]}" aria-labelledby="${SECTION_ANCHORS[s.id]}-title"><h2 id="${SECTION_ANCHORS[s.id]}-title">${e(s.title)}</h2>\n${SECTIONS[s.id](ctx, opts)}\n</section>`)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Asset Model Studio">
<title>${e(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="doc">
<header class="cover">
<h1>${e(title)}</h1>
<p class="muted">Generated by Asset Model Studio on ${e(formatDateTime(ctx.generatedAt))}.</p>
${ctx.project.description ? `<p class="lead">${e(ctx.project.description)}</p>` : ""}
</header>
${toc}
<main>
${body}
</main>
<footer>${e(ctx.project.name)} · Asset Model Studio · ${e(formatDateTime(ctx.generatedAt))}</footer>
</div>
</body>
</html>
`;
}
