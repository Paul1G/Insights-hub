// Asset timezone rules (Asset Management v3, schema `timezone`):
//   - a Java time zone id such as "America/Los_Angeles" or "Etc/GMT+2";
//   - zones that are 15 or 45 minutes off a UTC hour are NOT supported
//     (e.g. Asia/Kathmandu, UTC+05:45); 30-minute offsets are supported
//     (e.g. Asia/Kolkata, UTC+05:30);
//   - it can only be set at creation and never changed afterwards.
//
// Java and the browser both use the IANA tz database, so a zone id the
// browser's Intl implementation accepts is treated as a valid Java zone id.

export type TimezoneCheck =
  | { ok: true; offsets: string[] }
  | { ok: false; reason: "empty" | "unknown" | "quarter-hour-offset"; offsets?: string[] };

const cache = new Map<string, TimezoneCheck>();

function offsetMinutes(timeZone: string, at: Date): number | undefined {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
    year: "numeric",
  }).formatToParts(at);
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  if (name === "GMT" || name === "UTC") return 0;
  const m = /^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(name);
  if (!m) return undefined;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3] ?? "0"));
}

function formatOffset(min: number): string {
  const sign = min < 0 ? "-" : "+";
  const abs = Math.abs(min);
  const h = String(Math.floor(abs / 60)).padStart(2, "0");
  const m = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${h}:${m}`;
}

/** Validate a timezone id against the Insights Hub rules. */
export function checkTimezone(id: string): TimezoneCheck {
  const tz = id.trim();
  if (!tz) return { ok: false, reason: "empty" };
  const hit = cache.get(tz);
  if (hit) return hit;
  let result: TimezoneCheck;
  try {
    // Throws RangeError for unknown zones.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    const year = new Date().getUTCFullYear();
    const samples = Array.from({ length: 12 }, (_, month) => new Date(Date.UTC(year, month, 15, 12)));
    const mins = new Set<number>();
    for (const d of samples) {
      const o = offsetMinutes(tz, d);
      if (o !== undefined) mins.add(o);
    }
    const offsets = [...mins].sort((a, b) => a - b).map(formatOffset);
    const quarter = [...mins].some((m) => Math.abs(m) % 30 !== 0);
    result = quarter ? { ok: false, reason: "quarter-hour-offset", offsets } : { ok: true, offsets };
  } catch {
    result = { ok: false, reason: "unknown" };
  }
  cache.set(tz, result);
  return result;
}

export function timezoneMessage(check: TimezoneCheck, id: string): string | undefined {
  if (check.ok) return undefined;
  if (check.reason === "empty") return "Timezone is empty.";
  if (check.reason === "unknown") return `"${id}" is not a known Java/IANA time zone id.`;
  return `"${id}" has an offset that is 15 or 45 minutes off a UTC hour (${(check.offsets ?? []).join(
    ", ",
  )}), which Insights Hub does not support.`;
}

/** Supported time zone ids for pickers (filters out 15/45-minute zones). */
export function supportedTimezones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  const all = intl.supportedValuesOf ? intl.supportedValuesOf("timeZone") : [];
  const etc = Array.from({ length: 25 }, (_, i) => i - 12)
    .filter((n) => n !== 0)
    .map((n) => `Etc/GMT${n > 0 ? "+" : ""}${n}`);
  return ["UTC", ...all, ...etc].filter((tz, i, arr) => arr.indexOf(tz) === i && checkTimezone(tz).ok);
}
