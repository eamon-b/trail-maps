import { describe, it, expect } from 'vitest';
import { escapeHtml, formatKm, getQueryParam, isImportedTrailId } from './web-utils';

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
