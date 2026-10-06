/**
 * Tests that trail name/ID template injection in build-trails is safe.
 *
 * The build-trails script replaces {{TRAIL_NAME}} and {{TRAIL_ID}} in HTML templates.
 * These tests verify that the escape functions prevent XSS.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { escapeHtml, escapeJsString } from './escape';
// The substitution build-trails itself uses (build-trails.ts runs on import).
import { fillTemplate } from '../../scripts/lib/fill-template';

// What build-trails does: escaped values, placed by fillTemplate.
function applyTemplate(template: string, trailId: string, trailName: string): string {
  return fillTemplate(template, {
    TRAIL_ID: escapeJsString(trailId),
    TRAIL_NAME: escapeHtml(trailName),
    TRAIL_SHORT_NAME: escapeHtml(trailName),
    TRAIL_REGION: 'Test Region',
  });
}

// Read the actual templates used in production
const PLAN_TEMPLATE_PATH = resolve(__dirname, '../web/trails/plan-template.html');
let planTemplate: string;
try {
  planTemplate = readFileSync(PLAN_TEMPLATE_PATH, 'utf-8');
} catch {
  planTemplate = '<title>{{TRAIL_NAME}}</title><script>initPlanViewer("{{TRAIL_ID}}");</script>';
}

describe('template injection safety', () => {
  it('trail name with HTML tags must not create DOM elements', () => {
    const maliciousName = '<img src=x onerror=alert(1)>';
    const html = applyTemplate(planTemplate, 'safe-id', maliciousName);
    // The raw name should NOT appear unescaped in the output
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });

  it('trail name with script tag must not create executable script', () => {
    const maliciousName = '</title><script>alert("xss")</script><title>';
    const html = applyTemplate(planTemplate, 'safe-id', maliciousName);
    expect(html).not.toContain('<script>alert("xss")</script>');
  });

  it('trail ID with quote-breaking content must not escape JS string', () => {
    const maliciousId = "'); alert('xss'); //";
    const html = applyTemplate(planTemplate, maliciousId, 'Safe Name');
    // The JS context: initPlanViewer('{{TRAIL_ID}}')
    // After escaping, quotes and angle brackets are neutralized
    expect(html).not.toContain("alert('xss')");
  });

  it('trail name with ampersands and quotes is properly escaped', () => {
    const tricky = 'Trail "O\'Reilly" & Sons <TM>';
    const html = applyTemplate(planTemplate, 'safe-id', tricky);
    // Raw < and > should be escaped in HTML context
    expect(html).not.toContain('<TM>');
  });
});

describe('replacement patterns in values', () => {
  // String-form `.replace(regex, value)` reads `$&`, `$\``, `$'` and `$$` in
  // the value as patterns; a trail name containing one rewrote the page.
  it("inserts `$&`, backtick, `$'` and `$$` patterns literally", () => {
    const name = "Ben $& Jerry $` $' $$ Walk";
    const html = applyTemplate('<h1>{{TRAIL_NAME}}</h1><p>after</p>', 'id', name);
    expect(html).toBe(`<h1>${escapeHtml(name)}</h1><p>after</p>`);
    expect(html).not.toContain('{{TRAIL_NAME}}');
  });

  it('never re-substitutes a placeholder that appears inside a value', () => {
    const html = applyTemplate('<h1>{{TRAIL_NAME}}</h1><script>go("{{TRAIL_ID}}")</script>', 'x', '{{TRAIL_ID}}');
    expect(html).toBe('<h1>{{TRAIL_ID}}</h1><script>go("x")</script>');
  });

  it('leaves placeholders without a value untouched', () => {
    expect(fillTemplate('{{TRAIL_NAME}} {{OTHER}}', { TRAIL_NAME: 'A' })).toBe('A {{OTHER}}');
  });

  it('build-trails uses no string-form placeholder replacement', () => {
    const source = readFileSync(resolve(__dirname, '../../scripts/build-trails.ts'), 'utf-8');
    expect(source).not.toMatch(/\.replace\(\/\\\{\\\{[A-Z_]+\\\}\\\}\/g,\s*(?!\(\))/);
    expect(source).toContain('fillTemplate(template');
  });
});
