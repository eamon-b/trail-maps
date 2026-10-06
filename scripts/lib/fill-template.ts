/**
 * `{{PLACEHOLDER}}` substitution for the HTML templates `build-trails.ts`
 * renders (trail, climate and plan pages).
 *
 * Two properties the old chain of `.replace(regex, value)` calls lacked:
 *
 * - **Values are literal.** A string replacement interprets `$&`, `` $` ``,
 *   `$'` and `$$`, so a trail named "Ben $& Jerry's Walk" would have had the
 *   placeholder itself spliced back into the page (and `` $` ``/`$'` the whole
 *   template before/after it). The function form inserts the value verbatim.
 * - **One pass.** A value is never re-scanned, so a name that contains
 *   `{{TRAIL_ID}}` stays text instead of being substituted by a later step
 *   into a context its escaping was not written for.
 *
 * Values must already be escaped for where they land (`escapeHtml`,
 * `escapeJsString`); this only places them. Placeholders without a value are
 * left untouched, as the per-page chain left them.
 */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match
  );
}
