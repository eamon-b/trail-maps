import { resolveTheme, themeVariants, appModes, themeLabels, modeLabels, type ThemeColors, type ThemeVariant, type AppMode } from '../themes';

/**
 * Parse a hex color string to linear RGB components (0–1).
 * Supports #RGB, #RRGGBB formats.
 */
function hexToLinearRgb(hex: string): [number, number, number] {
  let r: number, g: number, b: number;
  const h = hex.replace('#', '');
  if (h.length === 3) {
    r = parseInt(h[0] + h[0], 16) / 255;
    g = parseInt(h[1] + h[1], 16) / 255;
    b = parseInt(h[2] + h[2], 16) / 255;
  } else {
    r = parseInt(h.slice(0, 2), 16) / 255;
    g = parseInt(h.slice(2, 4), 16) / 255;
    b = parseInt(h.slice(4, 6), 16) / 255;
  }
  // sRGB to linear
  const toLinear = (c: number) => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return [toLinear(r), toLinear(g), toLinear(b)];
}

/** Compute relative luminance per WCAG 2.1 */
function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToLinearRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Compute WCAG contrast ratio between two hex colors */
function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('Design Tokens — Themes', () => {
  const requiredKeys: (keyof ThemeColors)[] = [
    'background', 'surface', 'surfaceElevated',
    'textPrimary', 'textSecondary', 'textInverse',
    'border', 'borderSubtle',
    'accent', 'accentSubtle', 'accentMuted', 'accentOnDark', 'accentOnLight',
    'alertGreen', 'alertAmber', 'alertRed',
    'statusBarStyle',
  ];

  it('resolves all token keys for every theme × mode combination', () => {
    for (const variant of themeVariants) {
      for (const mode of appModes) {
        const resolved = resolveTheme(variant, mode);
        for (const key of requiredKeys) {
          expect(resolved[key]).toBeDefined();
          expect(resolved[key]).not.toBe('');
        }
      }
    }
  });

  it('produces distinct themes for each non-nightRed theme × mode', () => {
    // nightRed intentionally uses the same red-shifted accent for all modes
    const nonNightVariants = themeVariants.filter((v) => v !== 'nightRed');
    const combos = new Set<string>();
    for (const variant of nonNightVariants) {
      for (const mode of appModes) {
        const resolved = resolveTheme(variant, mode);
        combos.add(JSON.stringify(resolved));
      }
    }
    expect(combos.size).toBe(9); // 3 themes × 3 modes
  });

  it('light theme has dark status bar style', () => {
    const light = resolveTheme('light', 'plan');
    expect(light.statusBarStyle).toBe('dark');
  });

  it('dark themes have light status bar style', () => {
    for (const variant of ['dark', 'oled', 'nightRed'] as const) {
      const theme = resolveTheme(variant, 'plan');
      expect(theme.statusBarStyle).toBe('light');
    }
  });

  it('night red mode uses red-shifted accents for all modes', () => {
    for (const mode of appModes) {
      const theme = resolveTheme('nightRed', mode);
      // All night red accents should contain 'FF' (red-heavy hex values)
      expect(theme.accent).toMatch(/^#[Ff]{2}/);
    }
  });

  it('each mode has distinct accent colors in light theme', () => {
    const accents = appModes.map((m) => resolveTheme('light', m).accent);
    const uniqueAccents = new Set(accents);
    expect(uniqueAccents.size).toBe(3);
  });

  it('OLED theme uses true black background', () => {
    const oled = resolveTheme('oled', 'plan');
    expect(oled.background).toBe('#000000');
  });

  describe('WCAG AA contrast ratios (4.5:1)', () => {
    // Alert colors must be readable against the theme's background
    const alertKeys: (keyof ThemeColors)[] = ['alertGreen', 'alertAmber', 'alertRed'];

    for (const variant of themeVariants) {
      for (const mode of appModes) {
        it(`alert colors meet 4.5:1 against background in ${themeLabels[variant]} × ${modeLabels[mode]}`, () => {
          const theme = resolveTheme(variant, mode);
          for (const alertKey of alertKeys) {
            const alertColor = theme[alertKey] as string;
            const ratio = contrastRatio(alertColor, theme.background);
            expect(ratio).toBeGreaterThanOrEqual(4.5);
          }
        });
      }
    }

    for (const variant of themeVariants) {
      it(`textPrimary meets 4.5:1 against background in ${themeLabels[variant]}`, () => {
        const theme = resolveTheme(variant, 'plan');
        const ratio = contrastRatio(theme.textPrimary, theme.background);
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      });

      it(`textSecondary meets 3:1 against background in ${themeLabels[variant]}`, () => {
        const theme = resolveTheme(variant, 'plan');
        const ratio = contrastRatio(theme.textSecondary, theme.background);
        expect(ratio).toBeGreaterThanOrEqual(3.0);
      });
    }
  });
});
