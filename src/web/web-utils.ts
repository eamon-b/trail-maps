/**
 * Small pure helpers shared by the top-level web pages (index, upload,
 * my-trail, my-plan).
 *
 * Deliberately DOM-free so they can be unit-tested directly: the trail and plan
 * viewers each carry their own `escapeHtml` built on `document.createElement`,
 * which is fine inside those modules but untestable in isolation and unusable
 * before the document exists.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape a value for interpolation into HTML.
 *
 * Every user-supplied string on these pages (trail names above all) goes
 * through here before it reaches `innerHTML`. Quotes are escaped too, so the
 * result is also safe inside a double- or single-quoted attribute value.
 *
 * `null`/`undefined` become the empty string rather than the literal text
 * "null", which is what you want for optional fields.
 */
export function escapeHtml(value: unknown): string {
  if (value == null) return '';
  return String(value).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

/**
 * Read one query-string parameter.
 *
 * @param search  A location search string, with or without the leading `?`.
 * @returns The decoded value, or null when the parameter is absent or empty.
 */
export function getQueryParam(search: string, name: string): string | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const value = params.get(name);
  return value === null || value === '' ? null : value;
}

/**
 * True for an id minted by the runtime GPX importer (`u_` + content hash).
 *
 * Used to sanity-check `?id=` before hitting IndexedDB, so a hand-edited URL
 * lands on the friendly "trail not found" state instead of an odd lookup.
 */
export function isImportedTrailId(id: string): boolean {
  return /^u_[a-z0-9]{1,32}$/.test(id);
}

/** Format a distance in km for display (one decimal place). */
export function formatKm(km: number): string {
  return Number.isFinite(km) ? km.toFixed(1) : '—';
}
