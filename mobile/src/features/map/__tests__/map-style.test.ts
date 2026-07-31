import {
  FALLBACK_MAP_STYLE,
  isContourTileLoadFailure,
  labelFontForSource,
  mapRemountKey,
  resolveStyleSource,
  TRACK_COLORS,
  TRACK_DASH,
  TRACK_WIDTHS,
  trackWidthExpression,
} from '../map-style';

/** Rough perceptual distance between two #rrggbb colors (0 = identical). */
function colorDistance(a: string, b: string): number {
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
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
});

describe('mapRemountKey', () => {
  it('changes when the style source changes so the map remounts', () => {
    expect(mapRemountKey('online')).not.toBe(mapRemountKey('offline'));
  });

  it('is stable for a given source', () => {
    expect(mapRemountKey('offline')).toBe(mapRemountKey('offline'));
  });

  it('flips as a download completes (online -> offline)', () => {
    const before = mapRemountKey(resolveStyleSource('partial'));
    const after = mapRemountKey(resolveStyleSource('complete'));
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

describe('track cartography', () => {
  it('paints the three track classes in clearly different hues', () => {
    // The regression this guards: alternates used to be painted one brand-ramp
    // step from the main track's green, so they read as absent from the map.
    // 120 is comfortably beyond "different shade of the same colour".
    expect(colorDistance(TRACK_COLORS.main, TRACK_COLORS.alternate)).toBeGreaterThan(120);
    expect(colorDistance(TRACK_COLORS.main, TRACK_COLORS.sideTrip)).toBeGreaterThan(120);
    expect(colorDistance(TRACK_COLORS.alternate, TRACK_COLORS.sideTrip)).toBeGreaterThan(120);
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

describe('FALLBACK_MAP_STYLE', () => {
  it('is a valid, self-contained MapLibre style document', () => {
    expect(FALLBACK_MAP_STYLE.version).toBe(8);
    expect(FALLBACK_MAP_STYLE.sources).toEqual({});
    expect(FALLBACK_MAP_STYLE.layers).toHaveLength(1);
    expect(FALLBACK_MAP_STYLE.layers[0].type).toBe('background');
  });
});
