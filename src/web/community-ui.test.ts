import { describe, it, expect } from 'vitest';
import {
  checksListHtml,
  initRegionPicker,
  localCopyId,
  multilineHtml,
  regionLabel,
  reviewHtml,
  statusBadgeHtml,
  utf8ToBase64,
  OTHER_COUNTRY,
} from './community-ui';
import { isImportedTrailId } from './web-utils';

describe('community-ui', () => {
  it('escapes check messages and lists fails first', () => {
    const html = checksListHtml([
      { id: 'a', level: 'pass', message: 'ok' },
      { id: 'b', level: 'fail', message: '<img src=x onerror=alert(1)>' },
    ]);
    expect(html).not.toContain('<img');
    expect(html.indexOf('community-check-fail')).toBeLessThan(html.indexOf('community-check-pass'));
  });

  it('labels statuses and regions', () => {
    expect(statusBadgeHtml('unverified')).toContain('Unverified');
    expect(statusBadgeHtml('verified')).toContain('community-badge-verified');
    expect(regionLabel('AU', 'VIC')).toBe('Victoria, Australia');
    expect(regionLabel('JP', null)).toBe('Japan');
    expect(regionLabel('PE', null)).toBe('PE');
  });

  it('keeps line breaks but escapes markup', () => {
    expect(multilineHtml('a<b>\nc')).toBe('a&lt;b&gt;<br>c');
  });

  it('escapes the review text', () => {
    const html = reviewHtml({ status: 'done', verdict: 'reject', confidence: 0.9, summary: '<b>x</b>', concerns: ['<i>'] });
    expect(html).toContain('Reject (confidence 90%)');
    expect(html).not.toContain('<b>x');
    expect(html).not.toContain('<i>');
  });

  it('base64-encodes UTF-8', () => {
    expect(atob(utf8ToBase64('Mōtū'))).toBe(String.fromCharCode(...new TextEncoder().encode('Mōtū')));
  });

  it('a saved copy gets a stable import-shaped id', () => {
    const id = localCopyId('c_abcdefghijklmnop');
    expect(isImportedTrailId(id)).toBe(true);
    expect(localCopyId('c_abcdefghijklmnop')).toBe(id);
    expect(localCopyId('c_bbcdefghijklmnop')).not.toBe(id);
  });

  it('region picker: states follow the country, Other takes a free code', () => {
    document.body.innerHTML = `
      <select id="c"></select><div id="ow" hidden><input id="o"></div>
      <div id="sw" hidden><select id="s"></select></div>`;
    const country = document.getElementById('c') as HTMLSelectElement;
    const other = document.getElementById('o') as HTMLInputElement;
    const state = document.getElementById('s') as HTMLSelectElement;
    const sw = document.getElementById('sw')!;
    const ow = document.getElementById('ow')!;
    const picker = initRegionPicker(country, other, state, sw, ow);
    expect(picker.country()).toBeNull();

    picker.set('AU', 'TAS');
    expect(picker.country()).toBe('AU');
    expect(picker.state()).toBe('TAS');
    expect(sw.hidden).toBe(false);

    picker.set('JP', null);
    expect(sw.hidden).toBe(true);
    expect(picker.state()).toBeNull();

    country.value = OTHER_COUNTRY;
    country.dispatchEvent(new Event('change'));
    expect(ow.hidden).toBe(false);
    other.value = 'pe';
    other.dispatchEvent(new Event('input'));
    expect(picker.country()).toBe('PE');
  });
});
