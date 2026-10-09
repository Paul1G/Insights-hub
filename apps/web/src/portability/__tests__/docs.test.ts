/// <reference types="@vitest/browser/providers/playwright" />
import { describe, expect, it } from "vitest";
import { BUILTIN_CORE_LIBRARY } from "@/domain/coreLibrary";
import { createEmptyProject, type AssetDef, type Project } from "@/domain/model";
import { buildDocContext, generateDocumentation, renderHtml, renderMarkdown } from "../docs";
import { hierarchyDoc } from "../docs/content";
import { buildDiagramGraph, layoutDiagram, renderMermaid } from "../docs/diagram";
import { escapeHtml, escapeMarkdown } from "../docs/escape";
import { DOC_SECTIONS, defaultDocOptions } from "../docs/options";
import { pdfText } from "../docs/pdf";

const EVIL = `<script>alert("x")</script> | *bold* [link](javascript:x)`;

function sample(): Project {
  const p = createEmptyProject("Plant <North> & Co");
  p.description = EVIL;
  p.aspectTypes.push({
    uid: "apt-1",
    idSuffix: "Metrics",
    name: "Metrics",
    category: "dynamic",
    description: EVIL,
    variables: [{ uid: "v1", name: "rpm", dataType: "DOUBLE", unit: "1/min", searchable: false, qualityCode: true }],
  });
  p.assetTypes.push(
    {
      uid: "at-base",
      idSuffix: "Machine",
      name: "Machine",
      parent: { kind: "core", id: "core.basicasset" },
      instantiable: false,
      variables: [{ uid: "v2", name: "serial", dataType: "STRING", length: 32, searchable: true }],
      aspects: [],
      fileAssignments: [],
    },
    {
      uid: "at-pump",
      idSuffix: "Pump",
      name: "Pump",
      parent: { kind: "project", uid: "at-base" },
      instantiable: true,
      variables: [{ uid: "v3", name: "power", dataType: "DOUBLE", searchable: false }],
      aspects: [{ uid: "a1", name: "metrics", aspectType: { kind: "project", uid: "apt-1" } }],
      fileAssignments: [{ key: "manual", fileUid: "f1" }],
    },
  );
  p.files.push({ uid: "f1", name: "manual.pdf", scope: "private", mimeType: "application/pdf", size: 2048, sha256: "a".repeat(64), blobId: "b1" });
  const pump = (n: number, parentUid = "root"): AssetDef => ({
    uid: `p${n}`,
    name: n === 1 ? EVIL.replace(/\//g, "") : `Pump ${n}`,
    type: { kind: "project", uid: "at-pump" },
    parentUid,
    twinType: "performance",
    variables: [],
    aspects: [],
    fileAssignments: [],
  });
  p.assets.push(pump(1), pump(2), pump(3, "p2"), pump(4, "p3"));
  p.changelog.push({ at: p.createdAt, summary: "Added <pumps>" });
  return p;
}

const ctxOf = (p: Project) => buildDocContext(p, BUILTIN_CORE_LIBRARY, undefined, new Date("2026-10-06T10:00:00Z"));

describe("documentation generator", () => {
  it("escapes user content", () => {
    expect(escapeHtml(EVIL)).not.toMatch(/<script/);
    const md = escapeMarkdown(EVIL);
    expect(md).not.toMatch(/<script/);
    expect(md).toContain("\\|");
    expect(md).toContain("\\*bold\\*");
    expect(md).toContain("\\[link\\]");
  });

  it("Markdown contains every section, a Mermaid diagram and no raw HTML from user content", () => {
    const md = renderMarkdown(ctxOf(sample()), defaultDocOptions());
    for (const s of DOC_SECTIONS) expect(md).toContain(`## ${s.title}`);
    expect(md).toContain("```mermaid\ngraph TD");
    expect(md).toContain("### Pump");
    expect(md).toContain("Plant &lt;North&gt; &amp; Co");
    expect(md).not.toContain("<script>");
    expect(md).toContain("manual.pdf");
    expect(md).toContain("Added &lt;pumps&gt;");
  });

  it("HTML is a self-contained document with TOC, SVG diagram and escaped content", () => {
    const html = renderHtml(ctxOf(sample()), defaultDocOptions());
    expect(html.startsWith("<!doctype html>")).toBe(true);
    for (const s of DOC_SECTIONS) expect(html).toContain(`>${s.title}</h2>`);
    expect(html).toContain('<nav class="toc"');
    expect(html).toContain("<svg");
    expect(html).toContain("@media print");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/<link\b|src="http/);
    expect(html).toContain("&lt;script&gt;");
    // Inherited variables are documented with their origin.
    expect(html).toMatch(/serial<\/td>.*Machine<\/td>/s);
    const parsed = new DOMParser().parseFromString(html, "text/html");
    expect(parsed.querySelectorAll("h1")).toHaveLength(1);
    expect(parsed.querySelector("#asset-types")).not.toBeNull();
  });

  it("section toggles remove sections", () => {
    const opts = defaultDocOptions();
    opts.sections.changelog = false;
    opts.sections.diagram = false;
    const md = renderMarkdown(ctxOf(sample()), opts);
    expect(md).not.toContain("## Change log");
    expect(md).not.toContain("```mermaid");
    expect(md).toContain("## Asset types");
  });

  it("caps large hierarchies and reports omitted nodes", () => {
    const ctx = ctxOf(sample());
    const capped = hierarchyDoc(ctx, 2, 20);
    expect(capped.lines).toHaveLength(3); // root + 2 assets
    expect(capped.omitted).toBe(2);
    const shallow = hierarchyDoc(ctx, 100, 1);
    expect(shallow.lines.map((l) => l.depth)).toEqual([0, 1, 1]);
    expect(shallow.lines.find((l) => l.uid === "p2")?.hiddenChildren).toBe(2);
    const md = renderMarkdown(ctx, { ...defaultDocOptions(), hierarchyMaxNodes: 2 });
    expect(md).toMatch(/2 of 4 assets are not listed/);
  });

  it("lays out the diagram without overlapping nodes", () => {
    const graph = buildDiagramGraph(ctxOf(sample()));
    const layout = layoutDiagram(graph);
    expect(layout.nodes.map((n) => n.label).sort()).toEqual(["BasicAsset", "Machine", "Metrics", "Pump"]);
    for (const a of layout.nodes) {
      for (const b of layout.nodes) {
        if (a === b) continue;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap).toBe(false);
      }
    }
    expect(renderMermaid(graph)).toMatch(/-\.->\|"metrics"\|/);
  });

  it("generates a real PDF", async () => {
    const doc = await generateDocumentation("pdf", ctxOf(sample()), defaultDocOptions());
    expect(doc.fileName).toBe("plant-north-co-documentation-2026-10-06.pdf");
    expect(doc.blob.size).toBeGreaterThan(2000);
    const head = new TextDecoder().decode(await doc.blob.slice(0, 5).arrayBuffer());
    expect(head).toBe("%PDF-");
    expect(pdfText("Nürnberg → “A”")).toBe('Nürnberg -> "A"');
  });

  it("generates Markdown and HTML blobs with dated file names", async () => {
    const md = await generateDocumentation("md", ctxOf(sample()), defaultDocOptions());
    expect(md.fileName).toBe("plant-north-co-documentation-2026-10-06.md");
    expect(await md.blob.text()).toContain("# Plant");
    const html = await generateDocumentation("html", ctxOf(sample()), defaultDocOptions());
    expect(html.blob.type).toContain("text/html");
  });
});
