const pad = (n: number) => String(n).padStart(2, '0');

/** Offset from meeting start as "HH:MM:SS". */
export function formatOffset(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/** "52 min" or "1 h 5 min". */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

// Parts are assembled by hand because the separators Intl emits (e.g. U+202F
// before AM/PM, "Sept" for September in en-GB) vary between ICU versions.
function partsOf(d: Date, tz: string, options: Intl.DateTimeFormatOptions): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, ...options }).formatToParts(d);
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

/** "18 Nov 2026" in the given IANA timezone. */
export function formatDate(d: Date, tz: string): string {
  const p = partsOf(d, tz, { day: 'numeric', month: 'short', year: 'numeric' });
  return `${p.day} ${p.month} ${p.year}`;
}

/** "9:00 PM" in the given IANA timezone. */
export function formatTime(d: Date, tz: string): string {
  const p = partsOf(d, tz, { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${p.hour}:${p.minute} ${p.dayPeriod?.toUpperCase()}`;
}
