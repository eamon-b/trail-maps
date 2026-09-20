/**
 * One copy of the plan page's markup, shared by both planner pages.
 *
 * `src/web/trails/plan-shell.html` holds the `#plan-shell` body (the header
 * bar and the three-panel planner). This module is the only thing that knows
 * how to put it into a page: `scripts/build-trails.ts` uses it for
 * `plan-template.html`, the `plan-shell` plugin in `vite.config.ts` uses it
 * for `my-plan.html`, and the tests that boot either page's markup use it too,
 * so nothing has to repeat the fills.
 *
 * Deliberately free of `fs` and of `__dirname`/`import.meta.url`: this file is
 * loaded from an ESM tsx script, from esbuild's bundle of the Vite config and
 * from Vitest, and each of those resolves module paths differently. Callers
 * read the two files and hand over their text.
 */

/** The marker line a page carries where the shell goes. */
export const PLAN_SHELL_MARKER = '<!-- @plan-shell -->';

/** Matches the marker on a line of its own, with any indentation. */
const MARKER_LINE = /^[^\S\n]*<!-- @plan-shell -->[^\S\n]*$/m;

/** The header pieces that differ between the two planner pages. */
export interface PlanShellFills {
  /** Back link + trail title (`{{PLAN_HEADER_TRAIL}}`). */
  headerTrail: string;
  /** Anything after the save status (`{{PLAN_HEADER_EXTRA}}`) — the theme toggle. */
  headerExtra: string;
}

/**
 * A bundled trail page. `{{TRAIL_NAME}}` is left for the build script's own
 * substitution pass, which runs over the page after the shell is inlined.
 */
export const BUNDLED_PLAN_FILLS: PlanShellFills = {
  headerTrail:
    '<a href="index.html" class="back-link">← Trail</a>\n' +
    '      <span class="trail-title">{{TRAIL_NAME}}</span>',
  headerExtra: '<div data-theme-toggle></div>',
};

/**
 * `my-plan.html`. The name and the back href are only known once `my-plan.ts`
 * has read the imported trail out of IndexedDB, so both elements carry ids and
 * static placeholder text. No theme toggle: the page does not load `theme.ts`.
 */
export const IMPORTED_PLAN_FILLS: PlanShellFills = {
  headerTrail:
    '<a id="back-link" href="./" class="back-link">← Trail</a>\n' +
    '      <span class="trail-title" id="trail-title">Imported trail</span>',
  headerExtra: '',
};

/**
 * The inlinable part of `plan-shell.html`: everything from the opening
 * `<div id="plan-shell">` on, which drops the file's explanatory comment.
 */
export function planShellBody(shellHtml: string): string {
  const start = shellHtml.search(/^[^\S\n]*<div id="plan-shell">/m);
  if (start < 0) {
    throw new Error('plan-shell.html has no <div id="plan-shell"> line');
  }
  return shellHtml.slice(start).replace(/\s+$/, '');
}

/**
 * Replace a page's `@plan-shell` marker line with the shell, filled in.
 *
 * Throws when the marker is missing: a page that quietly lost its planner
 * would look fine to the build and be empty in the browser.
 */
export function inlinePlanShell(
  pageHtml: string,
  shellHtml: string,
  fills: PlanShellFills
): string {
  if (!MARKER_LINE.test(pageHtml)) {
    throw new Error(`page has no ${PLAN_SHELL_MARKER} marker line`);
  }
  let body = planShellBody(shellHtml);
  body = fillPlaceholder(body, 'PLAN_HEADER_TRAIL', fills.headerTrail);
  body = fillPlaceholder(body, 'PLAN_HEADER_EXTRA', fills.headerExtra);
  return pageHtml.replace(MARKER_LINE, () => body);
}

/**
 * Substitute one `{{NAME}}` placeholder. An empty fill takes its line with it,
 * so a page that does not want that element is not left with a blank,
 * trailing-whitespace line where it would have been.
 */
function fillPlaceholder(html: string, name: string, value: string): string {
  if (value === '') {
    return html.replace(new RegExp(`^[^\\S\\n]*\\{\\{${name}\\}\\}[^\\S\\n]*\\n`, 'gm'), '');
  }
  // Function form: the fill is HTML and must not be read as a `$&`-style
  // replacement pattern.
  return html.replace(new RegExp(`\\{\\{${name}\\}\\}`, 'g'), () => value);
}
