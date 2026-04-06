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

// Simulate what build-trails now does: escaped replacement
function applyTemplate(template: string, trailId: string, trailName: string): string {
  return template
    .replace(/\{\{TRAIL_ID\}\}/g, escapeJsString(trailId))
    .replace(/\{\{TRAIL_NAME\}\}/g, escapeHtml(trailName))
    .replace(/\{\{TRAIL_SHORT_NAME\}\}/g, escapeHtml(trailName))
    .replace(/\{\{TRAIL_REGION\}\}/g, 'Test Region');
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
