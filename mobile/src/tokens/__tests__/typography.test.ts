import { typography, MAX_FONT_SCALE } from '../typography';

describe('Design Tokens — Typography', () => {
  it('bodySmall and dataSmall respect the 14pt field-readability floor', () => {
    expect(typography.bodySmall.fontSize).toBeGreaterThanOrEqual(14);
    expect(typography.dataSmall.fontSize).toBeGreaterThanOrEqual(14);
  });

  it('dataSmall uses tabular figures for stable field numbers', () => {
    expect(typography.dataSmall.fontVariant).toContain('tabular-nums');
  });

  it('caps OS font scaling at 1.4x', () => {
    expect(MAX_FONT_SCALE).toBe(1.4);
  });

  it('every token defines fontSize and lineHeight', () => {
    for (const token of Object.values(typography)) {
      expect(token.fontSize).toBeGreaterThan(0);
      expect(token.lineHeight).toBeGreaterThanOrEqual(token.fontSize);
    }
  });
});
