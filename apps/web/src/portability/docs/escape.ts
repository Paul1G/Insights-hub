// Escaping of user content for the generated documents.

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape text for HTML element content and attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

/**
 * Escape inline Markdown text: HTML-significant characters become entities
 * (no raw HTML can be injected) and Markdown punctuation is backslash-escaped,
 * line breaks are flattened.
 */
export function escapeMarkdown(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_{}[\]()#+!|~])/g, "\\$1")
    .replace(/^(\s*\d+)\./, "$1\\.")
    .replace(/^(\s*)([-=])/, "$1\\$2")
    .replace(/\r?\n|\r/g, " ");
}

/** Escape a Markdown table cell (pipes, line breaks). */
export function escapeMarkdownCell(value: string): string {
  return escapeMarkdown(value);
}

/** Text inside a Mermaid quoted label: special characters as numeric entity codes. */
export function escapeMermaid(value: string): string {
  return value.replace(/\r?\n|\r/g, " ").replace(/["<>&#|`\\[\]{}]/g, (c) => `#${c.charCodeAt(0)};`);
}

/** Escape text for an SVG/XML text node or attribute. */
export const escapeXml = escapeHtml;
