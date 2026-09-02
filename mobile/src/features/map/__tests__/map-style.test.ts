import {
  degradationMessage,
  fallbackMapStyle,
  isBasemapGeometryNoise,
  isContourTileLoadFailure,
  isRedownloadFixable,
  labelFontForSource,
  mapDegradation,
  mapInk,
  mapRemountKey,
  resolveStyleSource,
  TRACK_DASH,
  TRACK_WIDTHS,
  trackColors,
  trackWidthExpression,
  type MapStyleResolution,
  type MapTheme,
} from '../map-style';

/** A healthy resolution, spread-overridden per case. */
const healthy: MapStyleResolution = {
  requested: 'offline',
  resolved: 'offline',
  contoursDropped: false,
  fallback: false,
};

/** Rough perceptual distance between two #rrggbb colors (0 = identical). */
function colorDistance(a: string, b: string): number {
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

const THEMES: MapTheme[] = ['light', 'dark'];

/**
 * The lightest ground each theme's basemaps paint: the offline topo style's
 * earth fill. The online styles are the same (#f8f4f0) or darker (rgb(12,12,12)),
 * so contrast measured here is the worst case for that theme.
 */
const BASEMAP_GROUND: Record<MapTheme, string> = {
  light: '#F8F4F0',
  dark: '#14161A',
};

const channels = (hex: string) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** WCAG relative luminance of an #rrggbb color. */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #rrggbb colors (1 = identical). */
function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Hue angle in degrees (0-360) of an #rrggbb color. */
function hueDegrees(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const h =
    max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/** Smallest angle between two hues, in degrees (0-180). */
function hueDistance(a: string, b: string): number {
  const diff = Math.abs(hueDegrees(a) - hueDegrees(b)) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/** The [zoom, value, ...] stops of an `interpolate` expression, as pairs. */
function stopsOf(expr: unknown[]): [number, number][] {
  const tail = expr.slice(3) as number[];
  return tail.reduce<[number, number][]>((acc, v, i) => {
    if (i % 2 === 0) acc.push([v, tail[i + 1]]);
    return acc;
  }, []);
}

describe('resolveStyleSource', () => {
  it('uses offline tiles only when the pack is verified complete', () => {
    expect(resolveStyleSource('complete')).toBe('offline');
  });

  it('falls back to online for partial, absent, or unknown state', () => {
    expect(resolveStyleSource('partial')).toBe('online');
    expect(resolveStyleSource('absent')).toBe('online');
    expect(resolveStyleSource(undefined)).toBe('online');
  });

  it('goes online while an update rewrites a complete pack in place', () => {
    // An update keeps on-disk state at 'complete' the whole time; holding the
    // mbtiles open in MapLibre while they are overwritten can abort natively.
    expect(resolveStyleSource('complete', { downloading: true })).toBe('online');
    expect(resolveStyleSource('complete', { downloading: false })).toBe('offline');
  });

  it('returns to offline once the download finishes', () => {
    const during = resolveStyleSource('complete', { downloading: true });
    const after = resolveStyleSource('complete', { downloading: false });
    expect(during).toBe('online');
    expect(after).toBe('offline');
    // ...and the flip remounts the map onto the freshly written tiles.
    expect(mapRemountKey(during, 'light')).not.toBe(mapRemountKey(after, 'light'));
  });
});

describe('mapDegradation', () => {
  it('reports nothing when the map got what it asked for', () => {
    expect(mapDegradation(healthy)).toBeNull();
    expect(mapDegradation({ ...healthy, requested: 'online', resolved: 'online' })).toBeNull();
  });

  it('reports an offline request that fell back to the online basemap', () => {
    expect(mapDegradation({ ...healthy, resolved: 'online' })).toBe('offline-unavailable');
  });

  it('reports dropped contours on an otherwise offline map', () => {
    expect(mapDegradation({ ...healthy, contoursDropped: true })).toBe('contours-missing');
  });

  it('reports the bare fallback ahead of any other degradation', () => {
    expect(mapDegradation({ ...healthy, resolved: 'online', fallback: true })).toBe('no-basemap');
  });

  it('gives every degradation user-facing copy, and only offers a re-download that can help', () => {
    for (const d of ['no-basemap', 'offline-unavailable', 'contours-missing'] as const) {
      expect(degradationMessage(d).length).toBeGreaterThan(0);
    }
    expect(isRedownloadFixable('offline-unavailable')).toBe(true);
    expect(isRedownloadFixable('contours-missing')).toBe(true);
    // No tiles and no network: downloading again is not the fix.
    expect(isRedownloadFixable('no-basemap')).toBe(false);
  });
});

describe('mapRemountKey', () => {
  it('changes when the style source changes so the map remounts', () => {
    expect(mapRemountKey('online', 'light')).not.toBe(mapRemountKey('offline', 'light'));
  });

  it('changes when the theme changes, because light and dark are different style documents', () => {
    expect(mapRemountKey('offline', 'light')).not.toBe(mapRemountKey('offline', 'dark'));
    expect(mapRemountKey('online', 'light')).not.toBe(mapRemountKey('online', 'dark'));
  });

  it('is stable for a given source and theme', () => {
    expect(mapRemountKey('offline', 'dark')).toBe(mapRemountKey('offline', 'dark'));
  });

  it('flips as a download completes (online -> offline)', () => {
    const before = mapRemountKey(resolveStyleSource('partial'), 'light');
    const after = mapRemountKey(resolveStyleSource('complete'), 'light');
    expect(before).not.toBe(after);
  });
});

describe('labelFontForSource', () => {
  it('uses Open Sans for the offline topo style', () => {
    expect(labelFontForSource('offline')).toEqual(['Open Sans Regular']);
  });

  it('uses Noto Sans for the online Liberty style', () => {
    expect(labelFontForSource('online')).toEqual(['Noto Sans Regular']);
  });
});

describe('isContourTileLoadFailure', () => {
  it('matches a failed contour tile log', () => {
    expect(
      isContourTileLoadFailure({ level: 'warning', message: 'Failed to load tile from source contour' }),
    ).toBe(true);
  });

  it('ignores unrelated failures and other sources', () => {
    expect(isContourTileLoadFailure({ level: 'error', message: 'Network unreachable' })).toBe(false);
    expect(
      isContourTileLoadFailure({ level: 'warning', message: 'Failed to load tile from source basemap' }),
    ).toBe(false);
  });
});

describe('isBasemapGeometryNoise', () => {
  // MapLibre RN 10 spelled the level 'warning'; v11's LogManager spells it
  // 'warn'. Both must match or the noise filter silently stops firing.
  it.each(['warn', 'warning'])('matches the %s-level basemap geometry warning', (level) => {
    expect(
      isBasemapGeometryNoise({ level, message: 'Invalid geometry in line layer foo' }),
    ).toBe(true);
  });

  it('leaves other warnings alone', () => {
    expect(isBasemapGeometryNoise({ level: 'warn', message: 'Something else' })).toBe(false);
    expect(
      isBasemapGeometryNoise({ level: 'error', message: 'Invalid geometry in line layer foo' }),
    ).toBe(false);
  });
});

describe('track cartography', () => {
  it.each(THEMES)('paints the three track classes in clearly different hues (%s)', (theme) => {
    // The regression this guards: alternates used to be painted one brand-ramp
    // step from the main track's green, so they read as absent from the map.
    // 120 is comfortably beyond "different shade of the same colour".
    const track = trackColors(theme);
    expect(colorDistance(track.main, track.alternate)).toBeGreaterThan(120);
    expect(colorDistance(track.main, track.sideTrip)).toBeGreaterThan(120);
    expect(colorDistance(track.alternate, track.sideTrip)).toBeGreaterThan(120);
  });

  it.each(THEMES)('keeps every track class legible against the %s basemap ground', (theme) => {
    // The dark-mode regression this guards: the light palette's violet and teal
    // sit at roughly the luminance of a dark basemap, so a dark map painted with
    // them loses its alternates and side trips entirely. Grounds are the lightest
    // each theme uses (offline #F8F4F0 / #14161A), so this is the tighter test.
    const track = trackColors(theme);
    for (const key of ['main', 'alternate', 'sideTrip'] as const) {
      expect(contrastRatio(track[key], BASEMAP_GROUND[theme])).toBeGreaterThan(3.5);
    }
  });

  it('keeps a class recognisable across themes: same hue family, different value', () => {
    // A violet line means "alternate" in either theme — the dark palette lifts
    // the value, it does not reassign the hue budget.
    for (const key of ['main', 'alternate', 'sideTrip'] as const) {
      const light = trackColors('light')[key];
      const dark = trackColors('dark')[key];
      expect(hueDistance(light, dark)).toBeLessThan(35);
      expect(luminance(dark)).toBeGreaterThan(luminance(light));
    }
  });

  it('distinguishes the classes by stroke as well as colour', () => {
    // Main is solid (no dash entry at all); the two variant classes dash
    // differently, so the classes survive greyscale / colour-blind viewing.
    expect(TRACK_DASH).not.toHaveProperty('main');
    expect(TRACK_DASH.alternate).not.toEqual(TRACK_DASH.sideTrip);
    for (const dash of [TRACK_DASH.alternate, TRACK_DASH.sideTrip]) {
      expect(dash).toHaveLength(2);
      expect(dash.every((n) => n > 0)).toBe(true);
    }
  });

  it('keeps the main track the widest class at every zoom', () => {
    const main = stopsOf(trackWidthExpression(TRACK_WIDTHS.main));
    const alternate = stopsOf(trackWidthExpression(TRACK_WIDTHS.alternate));
    const sideTrip = stopsOf(trackWidthExpression(TRACK_WIDTHS.sideTrip));
    expect(main).toHaveLength(3);
    main.forEach(([zoom, width], i) => {
      expect(alternate[i][0]).toBe(zoom);
      expect(width).toBeGreaterThan(alternate[i][1]);
      expect(width).toBeGreaterThan(sideTrip[i][1]);
    });
  });

  it('draws the casing wider than the main track it outlines', () => {
    const casing = stopsOf(trackWidthExpression(TRACK_WIDTHS.mainCasing));
    const main = stopsOf(trackWidthExpression(TRACK_WIDTHS.main));
    casing.forEach(([, width], i) => expect(width).toBeGreaterThan(main[i][1]));
  });

  it('thins lines at overview zoom and fattens them for walking zoom', () => {
    const expr = trackWidthExpression(10);
    expect(expr.slice(0, 3)).toEqual(['interpolate', ['linear'], ['zoom']]);
    const [overview, hiking, walking] = stopsOf(expr);
    expect(overview[1]).toBeLessThan(hiking[1]);
    expect(hiking[1]).toBe(10);
    expect(walking[1]).toBeGreaterThan(hiking[1]);
  });
});

describe('fallbackMapStyle', () => {
  it.each(THEMES)('is a valid, self-contained MapLibre style document (%s)', (theme) => {
    const style = fallbackMapStyle(theme);
    expect(style.version).toBe(8);
    expect(style.sources).toEqual({});
    expect(style.layers).toHaveLength(1);
    expect(style.layers[0].type).toBe('background');
  });

  it('backs the dark map with a dark ground, not the light one', () => {
    const paint = (theme: MapTheme) =>
      fallbackMapStyle(theme).layers[0].paint['background-color'];
    expect(paint('dark')).not.toBe(paint('light'));
    expect(luminance(paint('dark'))).toBeLessThan(luminance(paint('light')));
  });
});

describe('mapInk', () => {
  it('keeps the waypoint badge a white disc in both themes', () => {
    // The glyph PNGs are dark ink on transparency: the disc behind them has to
    // stay light or the glyph disappears. The category colour is the ring.
    expect(mapInk('light').badge).toBe(mapInk('dark').badge);
    expect(luminance(mapInk('dark').badge)).toBeGreaterThan(0.9);
  });

  it('inverts label ink so names read against either basemap', () => {
    expect(luminance(mapInk('light').labelText)).toBeLessThan(0.1);
    expect(luminance(mapInk('dark').labelText)).toBeGreaterThan(0.8);
  });
});
