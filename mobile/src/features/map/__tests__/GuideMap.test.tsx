/**
 * Shallow smoke test for the guide map.
 *
 * MapLibre is mocked to string host components; tileManager and the online
 * style service are mocked so no native/network work runs. The goal is to prove
 * the "resolve style before mount" flow works — loading first, then a mounted
 * <Map> — and that the offline/online/fallback branches pick the right style
 * source, not to verify pixel output.
 *
 * MapLibre RN 11 collapsed the per-type layer components into one <Layer
 * type="line|circle|symbol">, so layers are matched on the host node's `type`
 * prop rather than on its element name.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { GuideMap } from '../GuideMap';
import { tileManager } from '../../../services/tile-manager';
import { getOnlineMapStyle } from '../../../services/online-style-service';
import { WAYPOINT_ICON_NAMES } from '../waypoint-icons';

// jest.mock is hoisted above the imports above, so the mocked deps are in place
// before GuideMap's module evaluates.
jest.mock('@maplibre/maplibre-react-native', () => ({
  __esModule: true,
  Map: 'Map',
  Camera: 'Camera',
  GeoJSONSource: 'GeoJSONSource',
  Layer: 'Layer',
  Images: 'Images',
  LogManager: { onLog: jest.fn() },
}));

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

jest.mock('../../../services/tile-manager', () => ({
  tileManager: { getOfflineStyle: jest.fn() },
}));

jest.mock('../../../services/online-style-service', () => ({
  getOnlineMapStyle: jest.fn(),
}));

const getOfflineStyle = tileManager.getOfflineStyle as jest.Mock;
const getOnline = getOnlineMapStyle as jest.Mock;

/** Host-node type accessor (the ambient test-renderer types omit `.type`). */
const nodeType = (n: unknown) => (n as { type: unknown }).type;

/** Every mounted <Layer> of one MapLibre layer type ('line' / 'circle' / …). */
const layersOfType = (tree: ReactTestRenderer, layerType: string) =>
  tree.root.findAll((n) => nodeType(n) === 'Layer' && n.props.type === layerType);

/** First mounted <Layer> of `layerType` with the given id. */
const nodeById = (tree: ReactTestRenderer, layerType: string, id: string) =>
  layersOfType(tree, layerType).filter((n) => n.props.id === id)[0];

/** Every mounted <GeoJSONSource>. */
const sources = (tree: ReactTestRenderer) =>
  tree.root.findAll((n) => nodeType(n) === 'GeoJSONSource');

/** First mounted <GeoJSONSource> with the given id. */
const sourceById = (tree: ReactTestRenderer, id: string) =>
  sources(tree).filter((n) => n.props.id === id)[0];

/** A mounted node's press handler, typed so tests can invoke it. */
const pressHandler = (node: { props: Record<string, unknown> }) =>
  node.props.onPress as (event: unknown) => void;

/**
 * A MapLibre RN 11 press payload. Source and map handlers both take a
 * NativeSyntheticEvent, and source handlers call stopPropagation() to keep the
 * tap from also reaching <Map onPress>, so the stub has to carry one.
 */
const pressEvent = (nativeEvent: Record<string, unknown>) => ({
  nativeEvent,
  stopPropagation: jest.fn(),
});

const ONLINE_STYLE = { version: 8, sources: {}, layers: [] };
const OFFLINE_STYLE = { version: 8, sources: { basemap: {} }, layers: [] };
/** getOfflineStyle's structured result (see tile-manager's OfflineStyleResult). */
const offlineResult = (contoursDropped = false) => ({
  style: OFFLINE_STYLE,
  contoursDropped,
  reason: contoursDropped ? 'no tiles in tiles table' : undefined,
});

/** The `textFont` of a mounted symbol layer, e.g. the waypoint labels. */
const labelFontOf = (tree: ReactTestRenderer, id: string) => {
  const layer = nodeById(tree, 'symbol', id);
  return (layer.props.style as { textFont: string[] }).textFont;
};

const points = [
  { lat: -35, lon: 138, ele: 0, dist: 0 },
  { lat: -34, lon: 139, ele: 10, dist: 1 },
];
const waypoints = [{ id: 'w_1', name: 'Spring', lat: -35, lon: 138, type: 'water' }];

/** Flush the style-resolution promise chain and re-render. */
const flush = () => act(async () => { await new Promise((r) => setImmediate(r)); });

const mapViews = (tree: ReactTestRenderer) => tree.root.findAll((n) => nodeType(n) === 'Map');

let warnSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

describe('GuideMap', () => {
  it('shows a loading state before the style resolves, then mounts the map (online)', async () => {
    getOnline.mockResolvedValue(ONLINE_STYLE);
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <GuideMap trailId="heysen" styleSource="online" displayPoints={points} waypoints={waypoints} />,
      );
    });
    // Style not resolved yet: no map mounted.
    expect(mapViews(tree)).toHaveLength(0);

    await flush();
    expect(mapViews(tree)).toHaveLength(1);
    expect(getOnline).toHaveBeenCalled();
    expect(getOfflineStyle).not.toHaveBeenCalled();
  });

  it('resolves the offline style when the source is offline', async () => {
    getOfflineStyle.mockResolvedValue(offlineResult());
    getOnline.mockResolvedValue(ONLINE_STYLE);
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <GuideMap trailId="heysen" styleSource="offline" displayPoints={points} waypoints={waypoints} />,
      );
    });
    await flush();
    expect(getOfflineStyle).toHaveBeenCalledWith('heysen');
    expect(getOnline).not.toHaveBeenCalled();
    expect(mapViews(tree)).toHaveLength(1);
    expect(mapViews(tree)[0].props.mapStyle).toBe(OFFLINE_STYLE);
    // Offline topo tiles ship Open Sans glyphs.
    expect(labelFontOf(tree, 'guide-waypoints-labels')).toEqual(['Open Sans Regular']);
  });

  it('falls back online when an offline pack is missing at mount time', async () => {
    getOfflineStyle.mockResolvedValue(null);
    getOnline.mockResolvedValue(ONLINE_STYLE);
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <GuideMap trailId="heysen" styleSource="offline" displayPoints={points} />,
      );
    });
    await flush();
    expect(getOfflineStyle).toHaveBeenCalledWith('heysen');
    expect(getOnline).toHaveBeenCalled();
    expect(mapViews(tree)).toHaveLength(1);
  });

  it('labels and keys off the source that resolved, not the one requested', async () => {
    // The regression: styleSource='offline' + a damaged pack mounted the online
    // Liberty style but still asked it for Open Sans glyphs it does not serve,
    // so every label rendered as an empty box.
    getOfflineStyle.mockResolvedValue(null);
    getOnline.mockResolvedValue(ONLINE_STYLE);
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <GuideMap
          trailId="heysen"
          styleSource="offline"
          displayPoints={points}
          waypoints={waypoints}
        />,
      );
    });
    await flush();

    const map = mapViews(tree)[0];
    expect(map.props.mapStyle).toBe(ONLINE_STYLE);
    expect(labelFontOf(tree, 'guide-waypoints-labels')).toEqual(['Noto Sans Regular']);
    expect(labelFontOf(tree, 'guide-waypoints-cluster-counts')).toEqual(['Noto Sans Regular']);
  });

  it('reports what actually mounted so the pane can surface a degraded map', async () => {
    const onStyleResolved = jest.fn();
    getOfflineStyle.mockResolvedValue(offlineResult(true));
    getOnline.mockResolvedValue(ONLINE_STYLE);
    act(() => {
      TestRenderer.create(
        <GuideMap
          trailId="heysen"
          styleSource="offline"
          displayPoints={points}
          onStyleResolved={onStyleResolved}
        />,
      );
    });
    await flush();
    expect(onStyleResolved).toHaveBeenCalledWith({
      requested: 'offline',
      resolved: 'offline',
      contoursDropped: true,
      fallback: false,
      reason: 'no tiles in tiles table',
    });
  });

  it('reports the online fallback when the offline pack is unusable', async () => {
    const onStyleResolved = jest.fn();
    getOfflineStyle.mockResolvedValue(null);
    getOnline.mockResolvedValue(ONLINE_STYLE);
    act(() => {
      TestRenderer.create(
        <GuideMap
          trailId="heysen"
          styleSource="offline"
          displayPoints={points}
          onStyleResolved={onStyleResolved}
        />,
      );
    });
    await flush();
    expect(onStyleResolved).toHaveBeenCalledWith(
      expect.objectContaining({ requested: 'offline', resolved: 'online', fallback: false }),
    );
  });

  it('reports the bare fallback when no style resolves at all', async () => {
    const onStyleResolved = jest.fn();
    getOfflineStyle.mockResolvedValue(null);
    getOnline.mockRejectedValue(new Error('network down'));
    act(() => {
      TestRenderer.create(
        <GuideMap
          trailId="heysen"
          styleSource="offline"
          displayPoints={points}
          onStyleResolved={onStyleResolved}
        />,
      );
    });
    await flush();
    expect(onStyleResolved).toHaveBeenCalledWith(
      expect.objectContaining({ fallback: true, reason: 'network down' }),
    );
  });

  it('still mounts on a valid fallback style when resolution throws', async () => {
    getOfflineStyle.mockResolvedValue(null);
    getOnline.mockRejectedValue(new Error('network down'));
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <GuideMap trailId="heysen" styleSource="offline" displayPoints={points} />,
      );
    });
    await flush();
    expect(mapViews(tree)).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('renders trail-line and waypoint sources once mounted', async () => {
    getOnline.mockResolvedValue(ONLINE_STYLE);
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <GuideMap trailId="heysen" styleSource="online" displayPoints={points} waypoints={waypoints} />,
      );
    });
    await flush();
    const sourceIds = sources(tree).map((n) => n.props.id);
    expect(sourceIds).toContain('guide-trail-line');
    expect(sourceIds).toContain('guide-waypoints');
  });

  it('draws main / alternate / side-trip tracks as three distinct classes', async () => {
    getOnline.mockResolvedValue(ONLINE_STYLE);
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <GuideMap
          trailId="heysen"
          styleSource="online"
          displayPoints={points}
          alternates={[{ name: 'Alt', type: 'alternate', points }]}
          sideTrips={[{ name: 'Spur', type: 'side-trip', points }]}
        />,
      );
    });
    await flush();

    const layers = new Map<string, Record<string, unknown>>(
      layersOfType(tree, 'line').map((n) => [
        n.props.id as string,
        n.props.style as Record<string, unknown>,
      ]),
    );

    // All three classes are on the map, plus the main track's casing.
    expect([...layers.keys()]).toEqual(
      expect.arrayContaining([
        'guide-alternates-layer',
        'guide-side-trips-layer',
        'guide-trail-line-casing',
        'guide-trail-line-layer',
      ]),
    );

    const main = layers.get('guide-trail-line-layer')!;
    const alt = layers.get('guide-alternates-layer')!;
    const side = layers.get('guide-side-trips-layer')!;

    // Distinct colours: the bug was alternates sharing the main track's green.
    const colorsUsed = [main.lineColor, alt.lineColor, side.lineColor];
    expect(new Set(colorsUsed).size).toBe(3);
    // ...and the paint is theme-independent, so a dark-theme user sees the same
    // cartography (the mocked theme returns one colour for every token).
    expect(colorsUsed).not.toContain('#123456');

    // Distinct strokes: main solid, both variants dashed but not identically.
    expect(main.lineDasharray).toBeUndefined();
    expect(alt.lineDasharray).toBeDefined();
    expect(side.lineDasharray).toBeDefined();
    expect(alt.lineDasharray).not.toEqual(side.lineDasharray);
  });

  it('registers a bundled image for every marker glyph', async () => {
    // A marker whose `icon` names an unregistered image draws nothing at all,
    // and the registry has to be inside the map so a style flip re-applies it.
    getOnline.mockResolvedValue(ONLINE_STYLE);
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <GuideMap trailId="heysen" styleSource="online" displayPoints={points} waypoints={waypoints} />,
      );
    });
    await flush();

    const [images] = tree.root.findAll((n) => nodeType(n) === 'Images');
    const registered = Object.keys(images.props.images as Record<string, unknown>);
    expect(registered.sort()).toEqual([...WAYPOINT_ICON_NAMES].sort());
    // ...and the glyph layer reads the name straight off the feature.
    const icons = nodeById(tree, 'symbol', 'guide-waypoints-icons');
    expect((icons.props.style as { iconImage: unknown }).iconImage).toEqual(['get', 'icon']);
  });

  it('draws markers as a white badge ringed in the category color, glyph on top', async () => {
    getOnline.mockResolvedValue(ONLINE_STYLE);
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <GuideMap trailId="heysen" styleSource="online" displayPoints={points} waypoints={waypoints} />,
      );
    });
    await flush();

    const circles = nodeById(tree, 'circle', 'guide-waypoints-circles');
    const style = circles.props.style as Record<string, unknown>;
    // The ring carries the (theme-resolved) category color unless the feature
    // has an aggregated water status; the disc is white so the ink glyph on top
    // reads in either app theme.
    expect(style.circleStrokeColor).toEqual([
      'case',
      ['get', 'favorite'],
      '#123456',
      [
        'match',
        ['get', 'waterStatus'],
        'flowing',
        '#123456',
        'low',
        '#123456',
        'dry',
        '#123456',
        ['get', 'color'],
      ],
    ]);
    expect(style.circleColor).toBe('#ffffff');
    // Bigger than the 5 px dot it replaces, and favorites are bigger still.
    expect(style.circleRadius).toEqual(['case', ['get', 'favorite'], 11, 9]);
  });

  it('feeds the aggregated water status into the marker source', async () => {
    getOnline.mockResolvedValue(ONLINE_STYLE);
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <GuideMap
          trailId="heysen"
          styleSource="online"
          displayPoints={points}
          waypoints={waypoints}
          waterStatusById={new Map([['w_1', { status: 'dry' as const }]])}
        />,
      );
    });
    await flush();

    const source = sourceById(tree, 'guide-waypoints');
    const shape = source.props.data as GeoJSON.FeatureCollection;
    expect(shape.features[0].properties!.waterStatus).toBe('dry');
  });

  it('makes variant lines tappable with a fat invisible hit target', async () => {
    getOnline.mockResolvedValue(ONLINE_STYLE);
    const onVariantTap = jest.fn();
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <GuideMap
          trailId="heysen"
          styleSource="online"
          displayPoints={points}
          alternates={[{ name: 'Alt', type: 'alternate', points }]}
          sideTrips={[{ name: 'Spur', type: 'side-trip', points }]}
          onVariantTap={onVariantTap}
        />,
      );
    });
    await flush();

    for (const sourceId of ['guide-alternates', 'guide-side-trips']) {
      const source = sourceById(tree, sourceId);
      expect(source.props.onPress).toBeInstanceOf(Function);
      // Generous slop around the touch point — a 3 px dotted spur is otherwise
      // unhittable with a thumb. v11 takes the hitbox as edge insets, so this
      // is the same 44 x 44 target expressed as half-extents.
      expect(source.props.hitbox).toEqual({ top: 22, right: 22, bottom: 22, left: 22 });

      const hit = nodeById(tree, 'line', `${sourceId}-hit`);
      const hitStyle = hit.props.style as Record<string, unknown>;
      expect(hitStyle.lineWidth).toBeGreaterThanOrEqual(20);
      expect(hitStyle.lineOpacity).toBe(0);
    }

    // A tap reports the feature's stable id, which is how the pane finds the
    // variant object again.
    const alternates = sourceById(tree, 'guide-alternates');
    const event = pressEvent({
      features: [{ type: 'Feature', properties: { id: 'alternate-0' } }],
    });
    act(() => {
      pressHandler(alternates)(event);
    });
    expect(onVariantTap).toHaveBeenCalledWith('alternate-0');
    // ...and the tap does not also reach <Map onPress>, which would clear the
    // selection the same tap just made.
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it('highlights only the selected variant', async () => {
    getOnline.mockResolvedValue(ONLINE_STYLE);
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <GuideMap
          trailId="heysen"
          styleSource="online"
          displayPoints={points}
          alternates={[{ name: 'Alt', type: 'alternate', points }]}
          sideTrips={[{ name: 'Spur', type: 'side-trip', points }]}
          selectedVariantId="side-trip-0"
        />,
      );
    });
    await flush();

    const filterOf = (id: string) => nodeById(tree, 'line', id).props.filter;
    expect(filterOf('guide-side-trips-highlight')).toEqual(['==', ['get', 'id'], 'side-trip-0']);
    // The other class's highlight filter matches nothing.
    expect(filterOf('guide-alternates-highlight')).toEqual(['==', ['get', 'id'], 'side-trip-0']);
  });

  it('matches no variant when nothing is selected', async () => {
    getOnline.mockResolvedValue(ONLINE_STYLE);
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <GuideMap
          trailId="heysen"
          styleSource="online"
          displayPoints={points}
          alternates={[{ name: 'Alt', type: 'alternate', points }]}
        />,
      );
    });
    await flush();
    const layer = nodeById(tree, 'line', 'guide-alternates-highlight');
    // '' can never equal a variant id (which is always "<kind>-<index>").
    expect(layer.props.filter).toEqual(['==', ['get', 'id'], '']);
  });

  it('reports a tap that hit no overlay so the pane can clear its selection', async () => {
    getOnline.mockResolvedValue(ONLINE_STYLE);
    const onBackgroundPress = jest.fn();
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <GuideMap
          trailId="heysen"
          styleSource="online"
          displayPoints={points}
          onBackgroundPress={onBackgroundPress}
        />,
      );
    });
    await flush();
    act(() => {
      pressHandler(mapViews(tree)[0])(pressEvent({ lngLat: [138, -35], point: [0, 0] }));
    });
    expect(onBackgroundPress).toHaveBeenCalled();
  });

  it('gates overlay taps off while the route builder owns the map', async () => {
    // Every tap in builder mode is a route point, including one that lands on a
    // marker or a variant line.
    getOnline.mockResolvedValue(ONLINE_STYLE);
    const onMapPress = jest.fn();
    const onBackgroundPress = jest.fn();
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <GuideMap
          trailId="heysen"
          styleSource="online"
          displayPoints={points}
          waypoints={waypoints}
          alternates={[{ name: 'Alt', type: 'alternate', points }]}
          sideTrips={[{ name: 'Spur', type: 'side-trip', points }]}
          onVariantTap={jest.fn()}
          onBackgroundPress={onBackgroundPress}
          builderMode
          onMapPress={onMapPress}
        />,
      );
    });
    await flush();

    for (const sourceId of ['guide-alternates', 'guide-side-trips', 'guide-waypoints']) {
      expect(sourceById(tree, sourceId).props.onPress).toBeUndefined();
    }

    act(() => {
      pressHandler(mapViews(tree)[0])(pressEvent({ lngLat: [138.5, -34.5], point: [0, 0] }));
    });
    expect(onMapPress).toHaveBeenCalledWith(-34.5, 138.5);
    expect(onBackgroundPress).not.toHaveBeenCalled();
  });

  it('reports the settled viewport so the pane can turn it into a focus window', async () => {
    // Only the idle event is wired (onRegionDidChange, not onRegionIsChanging),
    // so the report is already debounced to "the user stopped moving the map".
    getOnline.mockResolvedValue(ONLINE_STYLE);
    const onVisibleBoundsChange = jest.fn();
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <GuideMap
          trailId="heysen"
          styleSource="online"
          displayPoints={points}
          onVisibleBoundsChange={onVisibleBoundsChange}
        />,
      );
    });
    await flush();

    const map = mapViews(tree)[0];
    const onRegionDidChange = map.props.onRegionDidChange as (event: unknown) => void;
    expect(map.props.onRegionIsChanging).toBeUndefined();

    act(() => {
      // v11 idle event: the viewport rides on nativeEvent as
      // bounds = [west, south, east, north].
      onRegionDidChange({
        nativeEvent: {
          center: [138.5, -34.5],
          zoom: 10,
          bearing: 0,
          pitch: 0,
          bounds: [138, -35, 139, -34],
          animated: false,
          userInteraction: true,
        },
      });
    });
    expect(onVisibleBoundsChange).toHaveBeenCalledWith({ ne: [139, -34], sw: [138, -35] });

    // A payload without bounds is ignored rather than reported as garbage.
    act(() => {
      onRegionDidChange({ nativeEvent: {} });
    });
    expect(onVisibleBoundsChange).toHaveBeenCalledTimes(1);
  });

  it('leaves the region handler off when nobody is listening', async () => {
    getOnline.mockResolvedValue(ONLINE_STYLE);
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <GuideMap trailId="heysen" styleSource="online" displayPoints={points} />,
      );
    });
    await flush();
    expect(mapViews(tree)[0].props.onRegionDidChange).toBeUndefined();
  });

  it('renders the route overlay source when a routeOverlay is supplied', async () => {
    getOnline.mockResolvedValue(ONLINE_STYLE);
    const routeOverlay: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: [[138, -35], [139, -34]] },
          properties: { straight: false },
        },
      ],
    };
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <GuideMap
          trailId="heysen"
          styleSource="online"
          displayPoints={points}
          routeOverlay={routeOverlay}
        />,
      );
    });
    await flush();
    expect(sources(tree).map((n) => n.props.id)).toContain('guide-route');
  });

  it('taps a waypoint without letting the tap fall through to the map', async () => {
    // v11 bubbles a source press up to <Map onPress> unless the source handler
    // stops it — unstopped, selecting a marker would immediately clear the
    // selection via onBackgroundPress.
    getOnline.mockResolvedValue(ONLINE_STYLE);
    const onWaypointTap = jest.fn();
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <GuideMap
          trailId="heysen"
          styleSource="online"
          displayPoints={points}
          waypoints={waypoints}
          onWaypointTap={onWaypointTap}
        />,
      );
    });
    await flush();

    const event = pressEvent({
      features: [{ type: 'Feature', properties: { id: 'w_1' } }],
    });
    act(() => {
      pressHandler(sourceById(tree, 'guide-waypoints'))(event);
    });
    expect(onWaypointTap).toHaveBeenCalledWith('w_1');
    expect(event.stopPropagation).toHaveBeenCalled();
  });
});
