import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  SITE_ROOT,
  escapeHtml,
  formatKm,
  generatedDataUrl,
  getQueryParam,
  isImportedTrailId,
  overpassEndpointOverride,
} from './web-utils';

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });

  it('neutralises a script-tag injection in a trail name', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('neutralises an attribute break-out', () => {
    // Rendered as href="${escapeHtml(name)}" this must not close the attribute.
    expect(escapeHtml('" onerror="alert(1)')).not.toContain('"');
  });

  it('returns an empty string for null and undefined', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('stringifies non-strings', () => {
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(0)).toBe('0');
    expect(escapeHtml(false)).toBe('false');
  });

  it('leaves safe text untouched', () => {
    expect(escapeHtml('Cape to Cape Track')).toBe('Cape to Cape Track');
  });
});

describe('getQueryParam', () => {
  it('reads a parameter with or without the leading ?', () => {
    expect(getQueryParam('?id=u_abc', 'id')).toBe('u_abc');
    expect(getQueryParam('id=u_abc', 'id')).toBe('u_abc');
  });

  it('picks the right parameter out of several', () => {
    expect(getQueryParam('?a=1&id=u_abc&z=3', 'id')).toBe('u_abc');
  });

  it('decodes percent-encoding', () => {
    expect(getQueryParam('?id=a%20b', 'id')).toBe('a b');
  });

  it('returns null for missing, empty, and empty-search cases', () => {
    expect(getQueryParam('?id=u_abc', 'other')).toBeNull();
    expect(getQueryParam('?id=', 'id')).toBeNull();
    expect(getQueryParam('', 'id')).toBeNull();
    expect(getQueryParam('?', 'id')).toBeNull();
  });
});

describe('isImportedTrailId', () => {
  it('accepts importer-minted ids', () => {
    expect(isImportedTrailId('u_1a2b3c4d5e6f')).toBe(true);
  });

  it('rejects bundled trail ids and junk', () => {
    expect(isImportedTrailId('heysen')).toBe(false);
    expect(isImportedTrailId('u_')).toBe(false);
    expect(isImportedTrailId('u_ABC')).toBe(false);
    expect(isImportedTrailId('../../etc/passwd')).toBe(false);
    expect(isImportedTrailId('u_abc/../x')).toBe(false);
  });
});

describe('formatKm', () => {
  it('formats to one decimal place', () => {
    expect(formatKm(123.456)).toBe('123.5');
    expect(formatKm(0)).toBe('0.0');
  });

  it('returns a dash for non-finite input', () => {
    expect(formatKm(NaN)).toBe('—');
    expect(formatKm(Infinity)).toBe('—');
  });
});

describe('generatedDataUrl', () => {
  it('finds the data beside the site root from a trail page', () => {
    expect(
      generatedDataUrl('heysen.json', SITE_ROOT.trailPage, 'https://host/trails/heysen/plan.html'),
    ).toBe('https://host/data/generated/heysen.json');
  });

  it('finds it from a top-level page', () => {
    expect(
      generatedDataUrl('heysen.json', SITE_ROOT.topLevel, 'https://host/shared-plan.html?s=abc'),
    ).toBe('https://host/data/generated/heysen.json');
  });

  it('stays under a site served from a sub-path, as `base: ./` allows', () => {
    // An absolute `/data/generated/…` would have gone to https://host/data/….
    expect(
      generatedDataUrl('cdt.json', SITE_ROOT.trailPage, 'https://host/trail-maps/trails/cdt/'),
    ).toBe('https://host/trail-maps/data/generated/cdt.json');
    expect(
      generatedDataUrl('cdt.json', SITE_ROOT.topLevel, 'https://host/trail-maps/shared-plan.html'),
    ).toBe('https://host/trail-maps/data/generated/cdt.json');
  });
});

describe('overpassEndpointOverride', () => {
  const link = '?id=u_abc&overpass=https%3A%2F%2Foverpass.kumi.systems%2Fapi%2Finterpreter';

  it('takes an https endpoint in a development build', () => {
    expect(overpassEndpointOverride(link, true)).toBe('https://overpass.kumi.systems/api/interpreter');
  });

  it('is ignored in a production build, so a crafted link cannot pick the host', () => {
    expect(overpassEndpointOverride(link, false)).toBeUndefined();
  });

  it('refuses anything but https, and anything that is not a URL', () => {
    expect(overpassEndpointOverride('?overpass=http://evil.test/collect', true)).toBeUndefined();
    expect(overpassEndpointOverride('?overpass=javascript:alert(1)', true)).toBeUndefined();
    expect(overpassEndpointOverride('?overpass=not a url', true)).toBeUndefined();
    expect(overpassEndpointOverride('?id=u_abc', true)).toBeUndefined();
  });
});

describe('the pages’ data fetches', () => {
  it('never ask for an absolute /data/… path, which a sub-path deployment misses', () => {
    const files = [
      'trails/climate-template.html',
      'trails/trail-viewer.ts',
      'trails/plan-viewer.ts',
      'shared-plan.ts',
      'index.html',
    ];
    for (const file of files) {
      const text = fs.readFileSync(path.join(__dirname, file), 'utf8');
      expect(text, file).not.toMatch(/fetch\(\s*[`'"]\/data\//);
    }
    expect(fs.readFileSync(path.join(__dirname, 'trails/climate-template.html'), 'utf8')).toContain(
      '../../data/generated/${TRAIL_ID}.json',
    );
  });
});
