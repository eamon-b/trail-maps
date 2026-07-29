import {
  FALLBACK_MAP_STYLE,
  isContourTileLoadFailure,
  labelFontForSource,
  mapRemountKey,
  resolveStyleSource,
} from '../map-style';

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

describe('FALLBACK_MAP_STYLE', () => {
  it('is a valid, self-contained MapLibre style document', () => {
    expect(FALLBACK_MAP_STYLE.version).toBe(8);
    expect(FALLBACK_MAP_STYLE.sources).toEqual({});
    expect(FALLBACK_MAP_STYLE.layers).toHaveLength(1);
    expect(FALLBACK_MAP_STYLE.layers[0].type).toBe('background');
  });
});
