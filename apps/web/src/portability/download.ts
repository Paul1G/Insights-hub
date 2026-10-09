// Browser download helpers and file naming for exported artefacts.

/** Turn a project name into a file-name friendly slug ("Plant A / Line 1" → "plant-a-line-1"). */
export function slugify(name: string, fallback = "project"): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || fallback;
}

/** Local calendar date as YYYY-MM-DD. */
export function isoDate(at: Date = new Date()): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, "0");
  const d = String(at.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** `<project-slug>-<part>-<YYYY-MM-DD>.<ext>` (part optional). */
export function exportFileName(projectName: string, ext: string, part?: string, at: Date = new Date()): string {
  const pieces = [slugify(projectName), part, isoDate(at)].filter(Boolean);
  return `${pieces.join("-")}.${ext}`;
}

/** Save a Blob through a temporary object URL. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke later: some browsers start the download asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Human readable byte size (1 decimal, binary units). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}
