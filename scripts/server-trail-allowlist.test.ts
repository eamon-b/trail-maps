/**
 * The app treats every bundled trail as server-known (`isServerKnown` in
 * mobile/src/services/server-trails.ts) and syncs comments for it, so the
 * comments API has to accept every one of them. Te Araroa shipped in the app
 * without joining `ALLOWED_TRAILS`, which would have had every comment posted
 * for it rejected with `invalid_trail`.
 *
 * The allowlist is read as text: importing the worker module would pull its
 * Cloudflare binding types into this project's `tsc`.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');

function allowedTrails(): string[] {
  const source = fs.readFileSync(
    path.join(ROOT, 'workers/comments-api/src/validation.ts'),
    'utf-8'
  );
  const literal = source.match(/ALLOWED_TRAILS[^=]*=\s*\[([\s\S]*?)\]/);
  if (!literal) throw new Error('ALLOWED_TRAILS array literal not found in validation.ts');
  return [...literal[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

function bundledTrails(): string[] {
  const index = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'mobile/assets/trails/index.json'), 'utf-8')
  ) as { id: string }[];
  return index.map((entry) => entry.id);
}

describe('comments API trail allowlist', () => {
  it('accepts exactly the trails bundled in the app', () => {
    const allowed = allowedTrails();
    expect(allowed.length).toBeGreaterThan(0);
    expect([...allowed].sort()).toEqual([...bundledTrails()].sort());
  });
});
