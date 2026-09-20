/**
 * The planner markup is shared between three pages that are assembled by
 * different tools — `build-trails.ts` for the bundled trail pages, the Vite
 * config's plugin for `my-plan.html` and `shared-plan.html` — so the thing
 * worth testing is that every page still asks for it and that each gets its
 * own header back.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  BUNDLED_PLAN_FILLS,
  IMPORTED_PLAN_FILLS,
  PLAN_SHELL_MARKER,
  SHARED_PLAN_FILLS,
  inlinePlanShell,
  planShellBody,
} from './plan-shell';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const shell = (): string => read('src/web/trails/plan-shell.html');
const template = (): string => read('src/web/trails/plan-template.html');
const myPlan = (): string => read('src/web/my-plan.html');
const sharedPlan = (): string => read('src/web/shared-plan.html');

describe('plan shell', () => {
  it('every plan page carries the marker and no markup of its own', () => {
    for (const page of [template(), myPlan(), sharedPlan()]) {
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
    // where the placeholder was: the header ends at the last shell control.
    expect(html).not.toContain('data-theme-toggle');
    expect(html).toContain('hidden>Share</button>\n    </div>');
    expect(html).not.toContain('{{');
  });

  it('gives shared-plan.html the owner line and the two actions it offers', () => {
    const html = inlinePlanShell(sharedPlan(), shell(), SHARED_PLAN_FILLS);
    expect(html).toContain('<span class="trail-title" id="trail-title">Shared plan</span>');
    expect(html).toContain('<span id="shared-by" class="shared-by"></span>');
    expect(html).toContain('id="open-in-app"');
    expect(html).toContain('id="copy-to-plans"');
    expect(html).not.toContain('{{');
  });

  it('carries the sync controls on every page, for plan-sync.ts to claim or remove', () => {
    for (const html of [
      inlinePlanShell(template(), shell(), BUNDLED_PLAN_FILLS),
      inlinePlanShell(myPlan(), shell(), IMPORTED_PLAN_FILLS),
      inlinePlanShell(sharedPlan(), shell(), SHARED_PLAN_FILLS),
    ]) {
      expect(html).toContain('id="sync-btn"');
      expect(html).toContain('id="link-dialog"');
      expect(html).toContain('id="share-panel"');
    }
  });

  it('inlines the same planner into every page', () => {
    const panels = (html: string): string =>
      html.slice(html.indexOf('<!-- Three-panel body -->'), html.indexOf('<!-- #plan-shell -->'));
    const bundled = panels(inlinePlanShell(template(), shell(), BUNDLED_PLAN_FILLS));
    expect(panels(inlinePlanShell(myPlan(), shell(), IMPORTED_PLAN_FILLS))).toBe(bundled);
    expect(panels(inlinePlanShell(sharedPlan(), shell(), SHARED_PLAN_FILLS))).toBe(bundled);
  });

  it('refuses a page with no marker rather than shipping an empty planner', () => {
    expect(() => inlinePlanShell('<body></body>', shell(), BUNDLED_PLAN_FILLS)).toThrow(
      /marker/
    );
  });
});
