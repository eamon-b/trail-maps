import { describe, expect, it } from 'vitest';
import { splitTextLinks } from './text-links';

const join = (text: string) =>
  splitTextLinks(text)
    .map((s) => s.text)
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
      { text: 'https://henrohouse.jp/en/houses/54', href: 'https://henrohouse.jp/en/houses/54' },
    ]);
  });

  it('finds a URL on its own line between other lines', () => {
    const text =
      'FREE pilgrim lodging.\n安楽寺通夜堂\nhttps://www.henro.org/place/anraku-ji-tsuyado\nTel: 0886942046';
    expect(splitTextLinks(text)).toEqual([
      { text: 'FREE pilgrim lodging.\n安楽寺通夜堂\n' },
      {
        text: 'https://www.henro.org/place/anraku-ji-tsuyado',
        href: 'https://www.henro.org/place/anraku-ji-tsuyado',
      },
      { text: '\nTel: 0886942046' },
    ]);
  });

  it('leaves sentence punctuation and an unopened bracket outside the link', () => {
    const segments = splitTextLinks('Book ahead (see http://example.com/a). Or www.example.org, too.');
    expect(segments.filter((s) => s.href)).toEqual([
      { text: 'http://example.com/a', href: 'http://example.com/a' },
      { text: 'www.example.org', href: 'https://www.example.org/' },
    ]);
  });

  it('keeps a bracket the URL itself opened', () => {
    const url = 'https://en.wikipedia.org/wiki/Henro_(pilgrimage)';
    expect(splitTextLinks(`${url}.`)[0]).toEqual({ text: url, href: url });
  });

  it('never links a non-http scheme', () => {
    expect(splitTextLinks('javascript:alert(1) ftp://x.org')).toEqual([
      { text: 'javascript:alert(1) ftp://x.org' },
    ]);
  });

  it('round-trips the input text', () => {
    const text = 'a https://x.org/b, c\nwww.y.com) d';
    expect(join(text)).toBe(text);
  });
});
