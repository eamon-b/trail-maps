/**
 * First-class, FarOut-style elevation profile rendered with Skia.
 *
 * Ported from the old app's `ElevationProfile` and extended for the new guide:
 *  - extreme-preserving LOD (precomputed once; selected per zoom — never
 *    resampled per frame),
 *  - pinch-zoom + pan over a windowed km range driven by reanimated shared
 *    values on the UI thread, committed to the controlled `window` prop,
 *  - waypoint markers on the trace (tap → `onWaypointTap`),
 *  - tap-to-scrub crosshair snapped to the nearest track point,
 *  - a `currentKm` GPS marker (plumbing only).
 *
 * The component is controlled: the parent owns the visible `window` and the
 * profile reports changes via `onWindowChange`. Colors are theme-resolved so
 * the Skia canvas adapts to dark mode.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { runOnJS, useSharedValue } from 'react-native-reanimated';
import { type DistanceUnit } from '@lib/format-distance';
import { useReduceMotion, useTheme } from '../../theme';
import { spacing, typography } from '../../tokens';
import { distanceAxisTicks, elevationAxis, getMinMax, type AxisTick } from './axis';
import {
  buildLodLevels,
  selectLodLevel,
  type ProfilePoint,
} from './lod';
import {
  buildProfileMarkers,
  clampWindow,
  hitTestMarkers,
  nearestPointByKm,
  xToKm,
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
  span: number;
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
  const [crosshair, setCrosshair] = useState<{ x: number; km: number; ele: number } | null>(null);

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

  const span = Math.max(window.endKm - window.startKm, 1e-6);
  const level = selectLodLevel(span, totalKm);
  const source = level === 'fine' ? lod.fine : lod.coarse;

  // Points within the window (with one neighbour each side for continuity).
  const windowedPoints = useMemo(() => {
    if (source.length === 0) return source;
    let lo = 0;
    let hi = source.length - 1;
    for (let i = 0; i < source.length; i++) {
      if (source[i].dist < window.startKm) lo = i;
      else break;
    }
    for (let i = source.length - 1; i >= 0; i--) {
      if (source[i].dist > window.endKm) hi = i;
      else break;
    }
    return source.slice(lo, hi + 1);
  }, [source, window.startKm, window.endKm]);

  // --- Chart metrics + Skia paths (rebuilt only when the window/size change) -
  const metrics = useMemo<PlotMetrics | null>(() => {
    if (windowedPoints.length === 0 || chartWidth <= 0 || chartHeight <= 0) return null;
    const { min: minEle, max: maxEle } = getMinMax(windowedPoints.map((p) => p.ele));
    // Ticks are nice in the display unit (m / ft, km / mi) but positioned in the
    // chart's native domain (metres / km) so the pixel mapping below is unit-agnostic.
    const ele = elevationAxis(minEle, maxEle, unit, 4);
    const distTicks = distanceAxisTicks(window.startKm, window.endKm, unit, 5);
    const eleRange = ele.max - ele.min || 1;
    return { eleMin: ele.min, eleRange, eleTicks: ele.ticks, distTicks, chartWidth, chartHeight, span };
  }, [windowedPoints, chartWidth, chartHeight, window.startKm, window.endKm, span, unit]);

  const clampX = useCallback(
    (x: number) => Math.max(left, Math.min(left + chartWidth, x)),
    [left, chartWidth],
  );

  const xOf = useCallback(
    (dist: number) => clampX(left + ((dist - window.startKm) / span) * chartWidth),
    [clampX, left, span, chartWidth, window.startKm],
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

  const currentPositionX = useMemo(() => {
    if (currentKm == null || currentKm < window.startKm || currentKm > window.endKm) return null;
    return left + ((currentKm - window.startKm) / span) * chartWidth;
  }, [currentKm, window.startKm, window.endKm, span, left, chartWidth]);

  // --- Gesture plumbing (stable across window changes via shared values) ----
  const winStart = useSharedValue(window.startKm);
  const winEnd = useSharedValue(window.endKm);
  useEffect(() => {
    winStart.value = window.startKm;
    winEnd.value = window.endKm;
  }, [window.startKm, window.endKm, winStart, winEnd]);

  const baseStart = useSharedValue(0);
  const baseEnd = useSharedValue(0);
  const focalX0 = useSharedValue(0);

  // Latest render state for tap handling (avoids stale gesture closures).
  const tapStateRef = useRef({ window, metrics, markers, plotLeft: left, plotWidth: chartWidth });
  tapStateRef.current = { window, metrics, markers, plotLeft: left, plotWidth: chartWidth };

  const lastPushRef = useRef(0);
  const reduceMotionRef = useRef(reduceMotion);
  reduceMotionRef.current = reduceMotion;
  const pushWindow = useCallback(
    (startKm: number, endKm: number, immediate: boolean) => {
      // Under reduce-motion, skip the continuous mid-gesture updates and only
      // settle the window when the gesture ends (immediate).
      if (!immediate && reduceMotionRef.current) return;
      const now = Date.now();
      if (!immediate && now - lastPushRef.current < WINDOW_THROTTLE_MS) return;
      lastPushRef.current = now;
      onWindowChange(clampWindow(startKm, endKm, totalKm));
    },
    [onWindowChange, totalKm],
  );

  const handleTap = useCallback(
    (tapX: number, tapY: number) => {
      const s = tapStateRef.current;
      if (!s.metrics) return;
      const hitId = hitTestMarkers(s.markers, tapX, tapY, WAYPOINT_TOUCH_RADIUS);
      if (hitId && onWaypointTap) {
        onWaypointTap(hitId);
        return;
      }
      const km = xToKm(tapX, s.window, { left: s.plotLeft, chartWidth: s.plotWidth });
      const nearest = nearestPointByKm(windowedPoints, km);
      if (!nearest) return;
      const x = s.plotLeft + ((nearest.dist - s.window.startKm) / span) * s.plotWidth;
      setCrosshair({ x, km: nearest.dist, ele: nearest.ele });
      onScrub?.({ km: nearest.dist, ele: nearest.ele });
    },
    [onWaypointTap, onScrub, windowedPoints, span],
  );

  const gesture = useMemo(() => {
    const cw = chartWidth;
    const plotLeft = left;
    const total = totalKm;
    const minSpan = Math.min(2, total);

    const pan = Gesture.Pan()
      .minDistance(8)
      .onStart(() => {
        baseStart.value = winStart.value;
        baseEnd.value = winEnd.value;
      })
      .onUpdate((e) => {
        const bs = baseStart.value;
        const be = baseEnd.value;
        const sp = be - bs;
        if (cw <= 0 || sp <= 0) return;
        const dxKm = (e.translationX / cw) * sp;
        let ns = bs - dxKm;
        let ne = be - dxKm;
        if (ns < 0) {
          ns = 0;
          ne = sp;
        }
        if (ne > total) {
          ne = total;
          ns = total - sp;
        }
        runOnJS(pushWindow)(ns, ne, false);
      })
      .onEnd(() => {
        runOnJS(pushWindow)(winStart.value, winEnd.value, true);
      });

    const pinch = Gesture.Pinch()
      .onStart((e) => {
        baseStart.value = winStart.value;
        baseEnd.value = winEnd.value;
        focalX0.value = e.focalX;
      })
      .onUpdate((e) => {
        const bs = baseStart.value;
        const be = baseEnd.value;
        const baseSpan = be - bs;
        if (cw <= 0 || baseSpan <= 0) return;
        let newSpan = baseSpan / e.scale;
        if (newSpan < minSpan) newSpan = minSpan;
        if (newSpan > total) newSpan = total;
        const fx = focalX0.value;
        const focalKm = bs + ((fx - plotLeft) / cw) * baseSpan;
        let ns = focalKm - ((fx - plotLeft) / cw) * newSpan;
        let ne = ns + newSpan;
        if (ns < 0) {
          ns = 0;
          ne = newSpan;
        }
        if (ne > total) {
          ne = total;
          ns = total - newSpan;
        }
        if (ns < 0) ns = 0;
        runOnJS(pushWindow)(ns, ne, false);
      })
      .onEnd(() => {
        runOnJS(pushWindow)(winStart.value, winEnd.value, true);
      });

    const tap = Gesture.Tap()
      .maxDistance(12)
      .onEnd((e) => {
        runOnJS(handleTap)(e.x, e.y);
      });

    return Gesture.Simultaneous(Gesture.Race(pinch, pan), tap);
    // Gestures read the live window through shared values, so they do NOT
    // depend on `window` — recreating them mid-gesture would cancel it.
  }, [
    chartWidth,
    left,
    totalKm,
    baseStart,
    baseEnd,
    winStart,
    winEnd,
    focalX0,
    pushWindow,
    handleTap,
  ]);

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

          {crosshair && (
            <Group>
              <Line
                p1={vec(crosshair.x, PADDING.top)}
                p2={vec(crosshair.x, PADDING.top + chartHeight)}
                color={colors.chartCrosshair}
                strokeWidth={StyleSheet.hairlineWidth}
              />
              <Circle cx={crosshair.x} cy={PADDING.top} r={3} color={colors.chartCrosshair} />
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
            style={[
              styles.axisLabel,
              { color: colors.textSecondary, left: xOf(tick.pos) - 12, bottom: 0 },
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
});
