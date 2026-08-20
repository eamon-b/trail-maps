import { resolveTheme, themeVariants, themeLabels, type ThemeColors } from '../themes';

/**
 * Parse a hex color string to linear RGB components (0–1).
 * Supports #RGB and #RRGGBB formats.
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
  const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
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
    'accent', 'accentSubtle', 'accentMuted', 'accentText',
    'danger', 'dangerText', 'warning', 'warningText', 'success', 'info',
    'waypointWater', 'waypointCamp', 'waypointTown', 'waypointShelter',
    'waypointJunction', 'waypointHazard', 'waypointFavorite',
    'waterFlowing', 'waterLow', 'waterDry',
    'downloadIdle', 'downloadActive', 'downloadDone', 'downloadError',
    'chartGrid', 'chartLine', 'chartFillTop', 'chartFillBottom',
    'chartCrosshair', 'chartMarker',
    'gps',
    'scrim',
    'statusBarStyle',
  ];

  it('resolves all token keys for every theme variant', () => {
    for (const variant of themeVariants) {
      const resolved = resolveTheme(variant);
      for (const key of requiredKeys) {
        expect(resolved[key]).toBeDefined();
        expect(resolved[key]).not.toBe('');
      }
    }
  });

  it('produces a distinct token set per variant', () => {
    const combos = new Set(themeVariants.map((v) => JSON.stringify(resolveTheme(v))));
    expect(combos.size).toBe(themeVariants.length);
  });

  it('light theme has a dark status bar style', () => {
    expect(resolveTheme('light').statusBarStyle).toBe('dark');
  });

  it('dark theme has a light status bar style', () => {
    expect(resolveTheme('dark').statusBarStyle).toBe('light');
  });

  it('dark theme background is the deep forest splash color', () => {
    expect(resolveTheme('dark').background).toBe('#081C15');
  });

  it('exposes a human label for every variant', () => {
    for (const variant of themeVariants) {
      expect(themeLabels[variant]).toBeTruthy();
    }
  });

  it('waypoint category colors are all distinct within each theme', () => {
    const waypointKeys: (keyof ThemeColors)[] = [
      'waypointWater', 'waypointCamp', 'waypointTown', 'waypointShelter',
      'waypointJunction', 'waypointFavorite',
    ];
    for (const variant of themeVariants) {
      const theme = resolveTheme(variant);
      const colors = waypointKeys.map((k) => theme[k]);
      expect(new Set(colors).size).toBe(waypointKeys.length);
    }
  });

  it('water-status ramp levels are distinguishable in every theme', () => {
    for (const variant of themeVariants) {
      const theme = resolveTheme(variant);
      expect(new Set([theme.waterFlowing, theme.waterLow, theme.waterDry]).size).toBe(3);
    }
  });

  it('download-state colors are distinguishable in every theme', () => {
    for (const variant of themeVariants) {
      const theme = resolveTheme(variant);
      const states = [theme.downloadIdle, theme.downloadActive, theme.downloadDone, theme.downloadError];
      expect(new Set(states).size).toBe(4);
    }
  });

  // Regression guard for the dark theme shipping `border === surfaceElevated`
  // (both palette.forest7), which made every hairline on an elevated card
  // invisible in dark mode.
  it('border is distinct from every surface token in each theme', () => {
    for (const variant of themeVariants) {
      const theme = resolveTheme(variant);
      for (const key of ['background', 'surface', 'surfaceElevated'] as const) {
        expect(theme.border).not.toBe(theme[key]);
      }
    }
  });

  it('border is perceptible against every surface it can be drawn on', () => {
    for (const variant of themeVariants) {
      const theme = resolveTheme(variant);
      for (const key of ['background', 'surface', 'surfaceElevated'] as const) {
        expect(contrastRatio(theme.border, theme[key])).toBeGreaterThanOrEqual(1.1);
      }
    }
  });

  describe('WCAG contrast', () => {
    for (const variant of themeVariants) {
      const label = themeLabels[variant];
      const theme = resolveTheme(variant);

      it(`${label}: textPrimary meets AA (4.5:1) against background`, () => {
        expect(contrastRatio(theme.textPrimary, theme.background)).toBeGreaterThanOrEqual(4.5);
      });

      it(`${label}: textPrimary meets AA (4.5:1) against surface and surfaceElevated`, () => {
        expect(contrastRatio(theme.textPrimary, theme.surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(theme.textPrimary, theme.surfaceElevated)).toBeGreaterThanOrEqual(4.5);
      });

      it(`${label}: textSecondary meets large-text/UI 3:1 against background`, () => {
        expect(contrastRatio(theme.textSecondary, theme.background)).toBeGreaterThanOrEqual(3.0);
      });

      it(`${label}: accentText meets AA (4.5:1) on an accent-filled surface`, () => {
        expect(contrastRatio(theme.accentText, theme.accent)).toBeGreaterThanOrEqual(4.5);
      });

      it(`${label}: danger/warning/success/info meet AA (4.5:1) against background`, () => {
        for (const key of ['danger', 'warning', 'success', 'info'] as const) {
          expect(contrastRatio(theme[key], theme.background)).toBeGreaterThanOrEqual(4.5);
        }
      });

      it(`${label}: dangerText and warningText meet AA on their filled surfaces`, () => {
        expect(contrastRatio(theme.dangerText, theme.danger)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(theme.warningText, theme.warning)).toBeGreaterThanOrEqual(4.5);
      });

      it(`${label}: waypoint + water-status + gps colors meet 3:1 against background`, () => {
        const keys: (keyof ThemeColors)[] = [
          'waypointWater', 'waypointCamp', 'waypointTown', 'waypointShelter',
          'waypointJunction', 'waypointHazard', 'waypointFavorite',
          'waterFlowing', 'waterLow', 'waterDry', 'gps',
        ];
        for (const key of keys) {
          expect(contrastRatio(theme[key] as string, theme.background)).toBeGreaterThanOrEqual(3.0);
        }
      });
    }
  });
});
