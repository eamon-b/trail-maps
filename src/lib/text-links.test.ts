import { describe, expect, it } from 'vitest';
import { MAX_LINK_LENGTH, splitTextLinks } from './text-links';

const join = (text: string) =>
  splitTextLinks(text)
    .map(s => s.text)
    .join('');

describe('splitTextLinks', () => {
  it('returns plain text as one segment', () => {
    expect(splitTextLinks('Water tank, reliable')).toEqual([{ text: 'Water tank, reliable' }]);
  });

  it('returns nothing for an empty string', () => {
    expect(splitTextLinks('')).toEqual([]);
  });

  it('finds a description that is only a URL', () => {
    expect(splitTextLinks('https://henrohouse.jp/en/houses/54')).toEqual([
      { text: 'https://henrohouse.jp/en/houses/54', href: 'https://henrohouse.jp/en/houses/54', kind: 'url' },
    ]);
  });

  it('finds a URL on its own line between other lines', () => {
    const text = 'FREE pilgrim lodging.\n安楽寺通夜堂\nhttps://www.henro.org/place/anraku-ji-tsuyado\nTel: 0886942046';
    expect(splitTextLinks(text)).toEqual([
      { text: 'FREE pilgrim lodging.\n安楽寺通夜堂\n' },
      {
        text: 'https://www.henro.org/place/anraku-ji-tsuyado',
        href: 'https://www.henro.org/place/anraku-ji-tsuyado',
        kind: 'url',
      },
      { text: '\nTel: ' },
      { text: '0886942046', href: 'tel:0886942046', kind: 'phone' },
    ]);
  });

  it('leaves sentence punctuation and an unopened bracket outside the link', () => {
    const segments = splitTextLinks('Book ahead (see http://example.com/a). Or www.example.org, too.');
    expect(segments.filter(s => s.href)).toEqual([
      { text: 'http://example.com/a', href: 'http://example.com/a', kind: 'url' },
      { text: 'www.example.org', href: 'https://www.example.org/', kind: 'url' },
    ]);
  });

  it('keeps a bracket the URL itself opened', () => {
    const url = 'https://en.wikipedia.org/wiki/Henro_(pilgrimage)';
    expect(splitTextLinks(`${url}.`)[0]).toEqual({ text: url, href: url, kind: 'url' });
  });

  it('never links a non-http scheme', () => {
    expect(splitTextLinks('javascript:alert(1) ftp://x.org')).toEqual([{ text: 'javascript:alert(1) ftp://x.org' }]);
  });

  it('trims a pile of unopened brackets in one pass', () => {
    // Quadratic re-counting took seconds on 20k brackets; this must be instant.
    const text = `see https://x.org/a${')'.repeat(1000)}.`;
    expect(splitTextLinks(text)).toEqual([
      { text: 'see ' },
      { text: 'https://x.org/a', href: 'https://x.org/a', kind: 'url' },
      { text: `${')'.repeat(1000)}.` },
    ]);
  });

  it('leaves an over-long match as plain text', () => {
    const text = `https://x.org/a${')'.repeat(50_000)}`;
    expect(splitTextLinks(text)).toEqual([{ text }]);
    const long = `https://x.org/${'a'.repeat(MAX_LINK_LENGTH)}`;
    expect(splitTextLinks(long)).toEqual([{ text: long }]);
    const fits = `https://x.org/${'a'.repeat(MAX_LINK_LENGTH - 'https://x.org/'.length)}`;
    expect(splitTextLinks(fits)[0].href).toBe(fits);
  });

  it('round-trips the input text', () => {
    const text = 'a https://x.org/b, c\nwww.y.com) d';
    expect(join(text)).toBe(text);
  });
});

describe('splitTextLinks: email addresses', () => {
  it('links an address in prose, leaving the full stop after it', () => {
    expect(splitTextLinks('Book by email: henroyadosora@gmail.com.')).toEqual([
      { text: 'Book by email: ' },
      { text: 'henroyadosora@gmail.com', href: 'mailto:henroyadosora@gmail.com', kind: 'email' },
      { text: '.' },
    ]);
  });

  it('links an address with a multi-part domain', () => {
    const [, link] = splitTextLinks('Email: jumbomami1507yo@yahoo.co.jp | Website');
    expect(link).toEqual({
      text: 'jumbomami1507yo@yahoo.co.jp',
      href: 'mailto:jumbomami1507yo@yahoo.co.jp',
      kind: 'email',
    });
  });

  it('leaves an @ inside a URL to the URL', () => {
    expect(splitTextLinks('https://x.org/user@host.com/a')).toEqual([
      { text: 'https://x.org/user@host.com/a', href: 'https://x.org/user@host.com/a', kind: 'url' },
    ]);
  });

  it('does not link a handle or an address without a domain', () => {
    expect(splitTextLinks('@henro_house and me@localhost')).toEqual([{ text: '@henro_house and me@localhost' }]);
  });
});

describe('splitTextLinks: phone numbers', () => {
  const phones = (text: string) =>
    splitTextLinks(text)
      .filter(s => s.kind === 'phone')
      .map(s => [s.text, s.href]);

  it('links the formats the trail descriptions use', () => {
    expect(phones('Cash only. Tel: 0885-42-4655 https://x.org')).toEqual([['0885-42-4655', 'tel:0885-42-4655']]);
    expect(phones('Paihia | Phone: (09) 402 7678 | Hours')).toEqual([['(09) 402 7678', 'tel:(09)4027678']]);
    expect(phones('Freephone 0800 229 8439 or +64 4 902 6287.')).toEqual([
      ['0800 229 8439', 'tel:08002298439'],
      ['+64 4 902 6287', 'tel:+6449026287'],
    ]);
    expect(phones('Reserve at least seven days ahead on 719-749-1234.')).toEqual([
      ['719-749-1234', 'tel:719-749-1234'],
    ]);
  });

  it('links a number without separators only after a label', () => {
    expect(phones('Ph 0886942046')).toEqual([['0886942046', 'tel:0886942046']]);
    expect(phones('routed over OSM highway ways 250206148, 971336802, 1456540997')).toEqual([]);
  });

  it('never links coordinates, dates, ranges or short numbers', () => {
    expect(phones('At -23.577480018413638, 147.123456 789 on 2026-09-21. Open 0800-1700. 1,234 m. 3 km 450')).toEqual(
      []
    );
  });

  it('leaves a number inside a URL or an email address alone', () => {
    expect(phones('https://x.org/080-3920-3826 and 0246-123-4567@x.com')).toEqual([]);
  });
});
