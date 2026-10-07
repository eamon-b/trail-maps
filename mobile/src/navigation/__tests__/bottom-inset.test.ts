/**
 * Edge-to-edge Android runs scroll content under the navigation bar, so the
 * last item of a screen (Settings' About card) could not be scrolled clear of
 * it. The inset is added on top of the screen's own bottom padding.
 */

import { StyleSheet } from 'react-native';
import { padForBottomInset } from '../bottom-inset';

const bottom = (style: Parameters<typeof padForBottomInset>[0], inset: number) =>
  StyleSheet.flatten(padForBottomInset(style, inset))?.paddingBottom;

describe('padForBottomInset', () => {
  it('adds the inset to the bottom padding the screen asks for', () => {
    expect(bottom({ paddingBottom: 32 }, 24)).toBe(56);
    expect(bottom({ paddingVertical: 8 }, 24)).toBe(32);
    expect(bottom({ padding: 16 }, 24)).toBe(40);
    expect(bottom({ padding: 16, paddingBottom: 4 }, 24)).toBe(28);
    expect(bottom([{ padding: 16 }, { paddingBottom: 2 }], 24)).toBe(26);
  });

  it('pads unpadded content by the inset alone', () => {
    expect(bottom(undefined, 24)).toBe(24);
  });

  it('leaves the style alone with no inset or a percentage padding', () => {
    const style = { padding: 16 };
    expect(padForBottomInset(style, 0)).toBe(style);
    const pct = { paddingBottom: '10%' as const };
    expect(padForBottomInset(pct, 24)).toBe(pct);
  });
});
