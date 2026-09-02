/**
 * First-class, FarOut-style elevation profile rendered with Skia.
 *
 * Ported from the old app's `ElevationProfile` and extended for the new guide:
 *  - extreme-preserving LOD (precomputed once; selected per zoom — never
 *    resampled per frame), with the raw track drawn verbatim once a zoomed
 *    window is small enough to afford it,
 *  - pinch-to-zoom on the x-axis (anchored on the pinch focal point) plus
 *    one-finger horizontal pan, committed to the controlled `window` prop,
 *  - waypoint markers on the trace (tap → `onWaypointTap`),
 *  - tap-to-scrub crosshair snapped to the nearest track point,
 *  - a `currentKm` GPS marker (plumbing only).
 *
 * The component is controlled: the parent owns the visible `window` and the
 * profile reports changes via `onWindowChange`. Colors are theme-resolved so
 * the Skia canvas adapts to dark mode.
 *
 * Gesture design: recognition happens on the UI thread (gesture-handler
 * worklets) but the window arithmetic runs on JS, against a snapshot of the
 * window taken at gesture start — so every frame is computed from the *raw*
 * gesture delta. That keeps the handlers referentially stable (a gesture object
 * recreated mid-drag is cancelled by gesture-handler) and makes the committed
 * window exact even when intermediate frames are throttled or suppressed.
 */

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import {
  Canvas,
  Circle,
  Group,
  LinearGradient,
  Line,
  Path,
  Rect,
  Skia,
  vec,
} from '@shopify/react-native-skia';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { type DistanceUnit } from '@lib/format-distance';
import { useReduceMotion, useTheme } from '../../theme';
import { spacing, typography } from '../../tokens';
import { distanceAxisTicks, elevationAxis, getMinMax, type AxisTick } from './axis';
import { buildLodLevels, selectWindowPoints, type ProfilePoint } from './lod';
import {
  buildProfileMarkers,
  clampWindow,
  hitTestMarkers,
  kmToX,
  nearestPointByKm,
  panWindowByPixels,
  xToKm,
  zoomWindowAtFocal,
  MIN_WINDOW_KM,
  type KmWindow,
} from './geometry';
import { waypointColor } from './waypoint-category';

const PADDING = { top: spacing.md, right: spacing.md, bottom: spacing.xl, left: spacing.xxl };
/** Touch radius (px) for waypoint hit-testing. */
const WAYPOINT_TOUCH_RADIUS = 22;
/** Marker dot radius (px): standard vs. favorited (slightly larger). */
const MARKER_RADIUS = 4;
const FAVORITE_MARKER_RADIUS = 6;
/** Max window state pushes per second while a gesture is active. */
const WINDOW_THROTTLE_MS = 33;
/** Pixels a finger must travel before a drag becomes a pan (vs. a tap). */
const PAN_MIN_DISTANCE = 6;
/** Box width (px) reserved for a centered x-axis label. */
const X_LABEL_WIDTH = 52;

/** A waypoint the profile can mark on the trace. */
export interface ProfileWaypoint {
  id: string;
  type: string;
  totalDistance?: number;
  elevation?: number;
}

/** A scrub readout (km + elevation) surfaced to the parent. */
export interface ProfileReadout {
  km: number;
  ele: number;
}

export interface ElevationProfileProps {
  /** Track points sorted ascending by `dist` (km). */
  points: ProfilePoint[];
  /** Trail length in km (window upper bound). */
  totalKm: number;
  /** Waypoints to mark on the trace. */
  waypoints?: ProfileWaypoint[];
  /** Starred waypoint ids — drawn larger, in the favorite color. */
  favoriteIds?: ReadonlySet<string>;
  /** Display unit for the axis labels + scrub readout. */
  unit: DistanceUnit;
  /** Controlled visible window [startKm, endKm]. */
  window: KmWindow;
  /** Reports a new visible window (pan/zoom). */
  onWindowChange: (window: KmWindow) => void;
  /**
   * On-trail km ranges to shade as translucent bands (e.g. an active custom
   * route's trail spans). Clipped to the visible window.
   */
  highlightRanges?: { startKm: number; endKm: number }[];
  /** Current GPS position (km) — draws the position marker. */
  currentKm?: number | null;
  /** Tap on a waypoint marker. */
  onWaypointTap?: (id: string) => void;
  /** Crosshair scrub readout (null when cleared). */
  onScrub?: (readout: ProfileReadout | null) => void;
}

interface PlotMetrics {
  eleMin: number;
  eleRange: number;
  eleTicks: AxisTick[];
  distTicks: AxisTick[];
  chartWidth: number;
  chartHeight: number;
}

export function ElevationProfile({
  points,
  totalKm,
  waypoints,
  favoriteIds,
  unit,
  window,
  onWindowChange,
  highlightRanges,
  currentKm,
  onWaypointTap,
  onScrub,
}: ElevationProfileProps) {
  const { colors } = useTheme();
  const reduceMotion = useReduceMotion();
  const [size, setSize] = useState({ width: 320, height: 220 });
  // Held in km (not pixels) so the crosshair stays glued to its track point
  // while the window pans/zooms underneath it.
  const [crosshair, setCrosshair] = useState<{ km: number; ele: number } | null>(null);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width > 0 && height > 0) setSize({ width, height });
  }, []);

  const chartWidth = size.width - PADDING.left - PADDING.right;
  const chartHeight = size.height - PADDING.top - PADDING.bottom;
  const left = PADDING.left;
  /** Elevation unit suffix for the y-axis (feet for imperial users). */
  const eleSuffix = unit === 'mi' ? 'ft' : 'm';

  // --- LOD: precompute once, pick per zoom (no per-frame resampling) --------
  const lod = useMemo(() => buildLodLevels(points), [points]);

  // Points to draw for the window: the raw track when a zoomed slice fits the
  // budget (full detail), otherwise a slice of the right LOD level.
  const windowedPoints = useMemo(
    () => selectWindowPoints(points, lod, window.startKm, window.endKm, totalKm),
    [points, lod, window.startKm, window.endKm, totalKm],
  );

  // --- Chart metrics + Skia paths (rebuilt only when the window/size change) -
  const metrics = useMemo<PlotMetrics | null>(() => {
    if (windowedPoints.length === 0 || chartWidth <= 0 || chartHeight <= 0) return null;
    const { min: minEle, max: maxEle } = getMinMax(windowedPoints.map((p) => p.ele));
    // Ticks are nice in the display unit (m / ft, km / mi) but positioned in the
    // chart's native domain (metres / km) so the pixel mapping below is unit-agnostic.
    const ele = elevationAxis(minEle, maxEle, unit, 4);
    const distTicks = distanceAxisTicks(window.startKm, window.endKm, unit, 5);
    const eleRange = ele.max - ele.min || 1;
    return { eleMin: ele.min, eleRange, eleTicks: ele.ticks, distTicks, chartWidth, chartHeight };
  }, [windowedPoints, chartWidth, chartHeight, window.startKm, window.endKm, unit]);

  const clampX = useCallback(
    (x: number) => Math.max(left, Math.min(left + chartWidth, x)),
    [left, chartWidth],
  );

  /** km → plot x, clamped to the plot edges (off-window neighbours pin there). */
  const xOf = useCallback(
    (dist: number) =>
      clampX(
        kmToX(dist, { startKm: window.startKm, endKm: window.endKm }, { left, chartWidth }),
      ),
    [clampX, left, chartWidth, window.startKm, window.endKm],
  );

  const elevationPath = useMemo(() => {
    if (!metrics || windowedPoints.length === 0) return null;
    const { eleMin, eleRange } = metrics;
    const path = Skia.Path.Make();
    for (let i = 0; i < windowedPoints.length; i++) {
      const p = windowedPoints[i];
      const x = xOf(p.dist);
      const y = PADDING.top + chartHeight - ((p.ele - eleMin) / eleRange) * chartHeight;
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    }
    return path;
  }, [metrics, windowedPoints, xOf, chartHeight]);

  const fillPath = useMemo(() => {
    if (!elevationPath) return null;
    const fill = elevationPath.copy();
    fill.lineTo(left + chartWidth, PADDING.top + chartHeight);
    fill.lineTo(left, PADDING.top + chartHeight);
    fill.close();
    return fill;
  }, [elevationPath, left, chartWidth, chartHeight]);

  // Dispose native Skia Path objects when replaced or on unmount.
  useEffect(() => () => elevationPath?.dispose(), [elevationPath]);
  useEffect(() => () => fillPath?.dispose(), [fillPath]);

  // --- Waypoint marker pixel positions -------------------------------------
  const markers = useMemo(() => {
    if (!metrics || !waypoints) return [];
    return buildProfileMarkers(
      waypoints,
      {
        startKm: window.startKm,
        endKm: window.endKm,
        left,
        chartWidth,
        top: PADDING.top,
        chartHeight,
        eleMin: metrics.eleMin,
        eleRange: metrics.eleRange,
      },
      (wp) =>
        favoriteIds?.has(wp.id)
          ? { color: colors.waypointFavorite, radius: FAVORITE_MARKER_RADIUS }
          : { color: waypointColor(wp.type, colors), radius: MARKER_RADIUS },
    );
  }, [metrics, waypoints, favoriteIds, window.startKm, window.endKm, left, chartWidth, chartHeight, colors]);

  const gridLines = useMemo(() => {
    if (!metrics) return [];
    const { eleMin, eleRange, eleTicks, distTicks } = metrics;
    const lines: { x1: number; y1: number; x2: number; y2: number }[] = [];
    for (const tick of eleTicks) {
      const y = PADDING.top + chartHeight - ((tick.pos - eleMin) / eleRange) * chartHeight;
      lines.push({ x1: left, y1: y, x2: left + chartWidth, y2: y });
    }
    for (const tick of distTicks) {
      const x = xOf(tick.pos);
      lines.push({ x1: x, y1: PADDING.top, x2: x, y2: PADDING.top + chartHeight });
    }
    return lines;
  }, [metrics, left, chartWidth, chartHeight, xOf]);

  // Translucent bands for highlighted km ranges (active route's trail spans),
  // clipped to the visible window. `xOf` clamps to the plot edges.
  const highlightBands = useMemo(() => {
    if (!metrics || !highlightRanges || highlightRanges.length === 0) return [];
    const bands: { x: number; width: number }[] = [];
    for (const r of highlightRanges) {
      if (r.endKm < window.startKm || r.startKm > window.endKm) continue;
      const x1 = xOf(Math.max(r.startKm, window.startKm));
      const x2 = xOf(Math.min(r.endKm, window.endKm));
      if (x2 > x1) bands.push({ x: x1, width: x2 - x1 });
    }
    return bands;
  }, [metrics, highlightRanges, window.startKm, window.endKm, xOf]);

  // GPS marker + scrub crosshair are both km-anchored: they follow the trail
  // under pan/zoom and disappear once scrolled out of the visible window.
  const currentPositionX = useMemo(() => {
    if (currentKm == null || currentKm < window.startKm || currentKm > window.endKm) return null;
    return xOf(currentKm);
  }, [currentKm, window.startKm, window.endKm, xOf]);

  const crosshairX = useMemo(() => {
    if (!crosshair || crosshair.km < window.startKm || crosshair.km > window.endKm) return null;
    return xOf(crosshair.km);
  }, [crosshair, window.startKm, window.endKm, xOf]);

  // --- Gesture plumbing -----------------------------------------------------
  // Everything the gesture handlers need is read through refs, so the handlers
  // (and therefore the `gesture` object) never change identity while a drag is
  // in flight — gesture-handler cancels an in-progress gesture if the
  // GestureDetector's config is swapped out.
  const windowRef = useRef(window);
  const layoutRef = useRef({ left, chartWidth });
  const onWindowChangeRef = useRef(onWindowChange);
  /** Latest render state for tap handling (avoids stale gesture closures). */
  const tapStateRef = useRef({ metrics, markers, points, onWaypointTap, onScrub });
  const lastPushRef = useRef(0);
  const reduceMotionRef = useRef(reduceMotion);
  const totalKmRef = useRef(totalKm);

  // Refs may not be written during render, so they are refreshed in a *layout*
  // effect (no dep array — every commit). Layout effects run synchronously on
  // commit, before anything is painted or can be touched, so a gesture still
  // cannot observe a frame-old window, layout or callback.
  useLayoutEffect(() => {
    windowRef.current = window;
    layoutRef.current = { left, chartWidth };
    onWindowChangeRef.current = onWindowChange;
    tapStateRef.current = { metrics, markers, points, onWaypointTap, onScrub };
    reduceMotionRef.current = reduceMotion;
    totalKmRef.current = totalKm;
  });

  const pushWindow = useCallback((next: KmWindow, immediate: boolean) => {
    // Under reduce-motion, skip the continuous mid-gesture updates and only
    // settle the window when the gesture ends (immediate). The end frame is
    // recomputed from the gesture's own delta, so nothing is lost.
    if (!immediate && reduceMotionRef.current) return;
    const now = Date.now();
    if (!immediate && now - lastPushRef.current < WINDOW_THROTTLE_MS) return;
    lastPushRef.current = now;
    onWindowChangeRef.current(clampWindow(next.startKm, next.endKm, totalKmRef.current));
  }, []);

  /** Window + pinch focal point snapshotted when the gesture started. */
  const gestureBaseRef = useRef<{ window: KmWindow; focalX: number } | null>(null);

  const beginGesture = useCallback((focalX: number) => {
    gestureBaseRef.current = { window: windowRef.current, focalX };
  }, []);

  const applyPan = useCallback(
    (translationX: number, immediate: boolean) => {
      const base = gestureBaseRef.current;
      if (!base) return;
      pushWindow(
        panWindowByPixels(
          base.window,
          translationX,
          layoutRef.current.chartWidth,
          totalKmRef.current,
        ),
        immediate,
      );
    },
    [pushWindow],
  );

  const applyPinch = useCallback(
    (scale: number, immediate: boolean) => {
      const base = gestureBaseRef.current;
      if (!base) return;
      pushWindow(
        zoomWindowAtFocal(
          base.window,
          scale,
          base.focalX,
          layoutRef.current,
          totalKmRef.current,
          MIN_WINDOW_KM,
        ),
        immediate,
      );
    },
    [pushWindow],
  );

  const handleTap = useCallback((tapX: number, tapY: number) => {
    const s = tapStateRef.current;
    if (!s.metrics) return;
    const hitId = hitTestMarkers(s.markers, tapX, tapY, WAYPOINT_TOUCH_RADIUS);
    if (hitId && s.onWaypointTap) {
      s.onWaypointTap(hitId);
      return;
    }
    const layout = layoutRef.current;
    const km = xToKm(tapX, windowRef.current, layout);
    // Snap against the full track so the readout is exact at any zoom level.
    const nearest = nearestPointByKm(s.points, km);
    if (!nearest) return;
    setCrosshair({ km: nearest.dist, ele: nearest.ele });
    s.onScrub?.({ km: nearest.dist, ele: nearest.ele });
  }, []);

  // The seven `react-hooks/refs` suppressions below are all the same false
  // positive, and the only ones in the app. The compiler cannot see inside
  // `Gesture.Pan().onStart(fn)`, so handing it a worklet that (via runOnJS)
  // reaches a ref-backed callback looks like a ref escaping into render. These
  // worklets only ever run from a touch, never during render — the values they
  // read are written in the layout effect above, one commit earlier. Removing
  // the suppressions means rebuilding the gesture whenever the window changes,
  // which is what the ref plumbing exists to avoid (see the note above), and
  // whether RNGH preserves an in-flight drag across that is a device question
  // this cannot be settled without.
  const gesture = useMemo(() => {
    // One finger drags the trail along the x-axis; `maxPointers(1)` keeps a
    // second finger from stealing the pinch.
    const pan = Gesture.Pan()
      .minDistance(PAN_MIN_DISTANCE)
      .maxPointers(1)
      // eslint-disable-next-line react-hooks/refs -- worklet, runs on touch only
      .onStart(() => {
        runOnJS(beginGesture)(0);
      })
      // eslint-disable-next-line react-hooks/refs -- worklet, runs on touch only
      .onUpdate((e) => {
        runOnJS(applyPan)(e.translationX, false);
      })
      // eslint-disable-next-line react-hooks/refs -- worklet, runs on touch only
      .onEnd((e) => {
        runOnJS(applyPan)(e.translationX, true);
      });

    // Pinch zooms the x-axis only; the y-axis keeps auto-fitting the window.
    const pinch = Gesture.Pinch()
      // eslint-disable-next-line react-hooks/refs -- worklet, runs on touch only
      .onStart((e) => {
        runOnJS(beginGesture)(e.focalX);
      })
      // eslint-disable-next-line react-hooks/refs -- worklet, runs on touch only
      .onUpdate((e) => {
        runOnJS(applyPinch)(e.scale, false);
      })
      // eslint-disable-next-line react-hooks/refs -- worklet, runs on touch only
      .onEnd((e) => {
        runOnJS(applyPinch)(e.scale, true);
      });

    const tap = Gesture.Tap()
      .maxDistance(12)
      // eslint-disable-next-line react-hooks/refs -- worklet, runs on touch only
      .onEnd((e) => {
        runOnJS(handleTap)(e.x, e.y);
      });

    return Gesture.Simultaneous(Gesture.Race(pinch, pan), tap);
    // Handlers are ref-backed and stable, so this gesture is built once per
    // mount — never rebuilt (and thus never cancelled) by a window change.
  }, [beginGesture, applyPan, applyPinch, handleTap]);

  if (points.length === 0 || !metrics) {
    return (
      <View style={[styles.empty, { backgroundColor: colors.surface }]} onLayout={onLayout}>
        <Text style={[styles.emptyText, { color: colors.textSecondary }]}>No elevation data</Text>
      </View>
    );
  }

  return (
    <View style={styles.container} onLayout={onLayout}>
      <GestureDetector gesture={gesture}>
        <Canvas style={{ width: size.width, height: size.height }}>
          <Group>
            {gridLines.map((l, i) => (
              <Line
                key={`grid-${i}`}
                p1={vec(l.x1, l.y1)}
                p2={vec(l.x2, l.y2)}
                color={colors.chartGrid}
                strokeWidth={StyleSheet.hairlineWidth}
              />
            ))}
          </Group>

          {/* Active-route highlight bands (behind the trace + fill). */}
          {highlightBands.map((b, i) => (
            <Rect
              key={`hl-${i}`}
              x={b.x}
              y={PADDING.top}
              width={b.width}
              height={chartHeight}
              color={colors.chartFillTop}
            />
          ))}

          {fillPath && (
            <Path path={fillPath}>
              <LinearGradient
                start={vec(0, PADDING.top)}
                end={vec(0, PADDING.top + chartHeight)}
                colors={[colors.chartFillTop, colors.chartFillBottom]}
              />
            </Path>
          )}

          {elevationPath && (
            <Path
              path={elevationPath}
              color={colors.chartLine}
              style="stroke"
              strokeWidth={2}
              strokeCap="round"
              strokeJoin="round"
            />
          )}

          {markers.map((m) => (
            <Circle key={m.id} cx={m.x} cy={m.y} r={m.radius} color={m.color} />
          ))}

          {currentPositionX != null && (
            <Group>
              <Line
                p1={vec(currentPositionX, PADDING.top)}
                p2={vec(currentPositionX, PADDING.top + chartHeight)}
                color={colors.chartMarker}
                strokeWidth={2}
              />
              <Circle cx={currentPositionX} cy={PADDING.top} r={4} color={colors.chartMarker} />
            </Group>
          )}

          {crosshairX != null && (
            <Group>
              <Line
                p1={vec(crosshairX, PADDING.top)}
                p2={vec(crosshairX, PADDING.top + chartHeight)}
                color={colors.chartCrosshair}
                strokeWidth={StyleSheet.hairlineWidth}
              />
              <Circle cx={crosshairX} cy={PADDING.top} r={3} color={colors.chartCrosshair} />
            </Group>
          )}
        </Canvas>
      </GestureDetector>

      {/* Axis labels as RN Text for legible glyphs. */}
      <View style={styles.yLabels} pointerEvents="none">
        {metrics.eleTicks.map((tick) => {
          const y =
            PADDING.top + chartHeight - ((tick.pos - metrics.eleMin) / metrics.eleRange) * chartHeight;
          return (
            <Text
              key={`y-${tick.pos}`}
              style={[styles.axisLabel, { color: colors.textSecondary, top: y - 6, left: 0 }]}
            >
              {tick.label}
              {eleSuffix}
            </Text>
          );
        })}
      </View>
      <View style={styles.xLabels} pointerEvents="none">
        {metrics.distTicks.map((tick) => (
          <Text
            key={`x-${tick.pos}`}
            numberOfLines={1}
            style={[
              styles.axisLabel,
              styles.xLabel,
              {
                color: colors.textSecondary,
                left: xOf(tick.pos) - X_LABEL_WIDTH / 2,
                bottom: 0,
              },
            ]}
          >
            {tick.label}
          </Text>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    position: 'relative',
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    ...typography.caption,
  },
  yLabels: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
  },
  xLabels: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
  axisLabel: {
    position: 'absolute',
    ...typography.caption,
    fontVariant: ['tabular-nums'],
  },
  // Fixed-width, centered box so multi-digit zoomed labels (e.g. "123.6") sit
  // on their tick instead of drifting right.
  xLabel: {
    width: X_LABEL_WIDTH,
    textAlign: 'center',
  },
});
