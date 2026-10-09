// RFC 4180 CSV parsing and serialisation (comma or semicolon separated, as
// produced by Excel in different locales).

export interface CsvTable {
  headers: string[];
  rows: Record<string, string>[];
}

/** Detect the delimiter from the first line (outside quotes). */
export function detectDelimiter(text: string): "," | ";" | "\t" {
  let inQuotes = false;
  const counts = { ",": 0, ";": 0, "\t": 0 };
  for (const ch of text) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === "\n" || ch === "\r")) break;
    else if (!inQuotes && ch in counts) counts[ch as keyof typeof counts]++;
  }
  if (counts[";"] > counts[","] && counts[";"] >= counts["\t"]) return ";";
  if (counts["\t"] > counts[","]) return "\t";
  return ",";
}

/** Parse CSV text into rows of cells. Handles quotes, escaped quotes and CRLF. */
export function parseCsvRows(text: string, delimiter = detectDelimiter(text)): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") inQuotes = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Parse CSV with a header row into objects keyed by (trimmed) header. */
export function parseCsv(text: string, delimiter?: "," | ";" | "\t"): CsvTable {
  const rows = parseCsvRows(text, delimiter ?? detectDelimiter(text));
  const [head, ...body] = rows;
  if (!head) return { headers: [], rows: [] };
  const headers = head.map((h) => h.trim());
  return {
    headers,
    rows: body.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""]))),
  };
}

function escapeCell(value: string, delimiter: string): string {
  return /["\r\n]/.test(value) || value.includes(delimiter) || /^\s|\s$/.test(value)
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

/** Serialise rows to CSV (CRLF line endings, as RFC 4180 specifies). */
export function toCsv(headers: string[], rows: Record<string, string | number | boolean | undefined | null>[], delimiter = ","): string {
  const lines = [headers.map((h) => escapeCell(h, delimiter)).join(delimiter)];
  for (const r of rows) {
    lines.push(headers.map((h) => escapeCell(r[h] === undefined || r[h] === null ? "" : String(r[h]), delimiter)).join(delimiter));
  }
  return `${lines.join("\r\n")}\r\n`;
}
