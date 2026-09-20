/**
 * The planner markup is shared between two pages that are assembled by
 * different tools — `build-trails.ts` for the bundled trail pages, the Vite
 * config's plugin for `my-plan.html` — so the thing worth testing is that both
 * pages still ask for it and that each gets its own header back.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  BUNDLED_PLAN_FILLS,
  IMPORTED_PLAN_FILLS,
  PLAN_SHELL_MARKER,
  inlinePlanShell,
  planShellBody,
} from './plan-shell';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const shell = (): string => read('src/web/trails/plan-shell.html');
const template = (): string => read('src/web/trails/plan-template.html');
const myPlan = (): string => read('src/web/my-plan.html');

describe('plan shell', () => {
  it('both plan pages carry the marker and no markup of their own', () => {
    for (const page of [template(), myPlan()]) {
      expect(page).toContain(PLAN_SHELL_MARKER);
      expect(page).not.toContain('id="plan-header"');
      expect(page).not.toContain('id="plan-body"');
    }
  });

  it('leaves the file comment out of what it inlines', () => {
    const body = planShellBody(shell());
    expect(body.startsWith('  <div id="plan-shell">')).toBe(true);
    expect(body).not.toContain('Placeholders beat');
  });

  it('gives a bundled trail page the substitutable header', () => {
    const html = inlinePlanShell(template(), shell(), BUNDLED_PLAN_FILLS);
    expect(html).toContain('<a href="index.html" class="back-link">');
    expect(html).toContain('<span class="trail-title">{{TRAIL_NAME}}</span>');
    expect(html).toContain('<div data-theme-toggle></div>');
    expect(html).not.toContain(PLAN_SHELL_MARKER);
    expect(html).not.toContain('{{PLAN_HEADER_');
  });

  it('gives my-plan.html the ids its boot script fills at runtime', () => {
    const html = inlinePlanShell(myPlan(), shell(), IMPORTED_PLAN_FILLS);
    expect(html).toContain('<a id="back-link" href="./" class="back-link">');
    expect(html).toContain('<span class="trail-title" id="trail-title">Imported trail</span>');
    // No theme.ts on this page, so no toggle — and no blank line left behind
    // where the placeholder was.
    expect(html).not.toContain('data-theme-toggle');
    expect(html).toContain('<span id="save-status">Saved</span>\n    </div>');
    expect(html).not.toContain('{{');
  });

  it('inlines the same planner into both pages', () => {
    const panels = (html: string): string =>
      html.slice(html.indexOf('<!-- Three-panel body -->'), html.indexOf('<!-- #plan-shell -->'));
    expect(panels(inlinePlanShell(myPlan(), shell(), IMPORTED_PLAN_FILLS))).toBe(
      panels(inlinePlanShell(template(), shell(), BUNDLED_PLAN_FILLS))
    );
  });

  it('refuses a page with no marker rather than shipping an empty planner', () => {
    expect(() => inlinePlanShell('<body></body>', shell(), BUNDLED_PLAN_FILLS)).toThrow(
      /marker/
    );
  });
});
