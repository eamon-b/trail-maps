import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { StyleSheet, View, Text, LayoutChangeEvent } from 'react-native';
import { Canvas, Path, Skia, LinearGradient, vec, Line, Circle, Group, Rect } from '@shopify/react-native-skia';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { getMinMax, niceAxisTicks, findNearestByDistance, type TrackPoint, type TrailWaypoint } from '../lib/trail-utils';
import { useTheme } from '../theme';
import { spacing } from '../tokens/spacing';
import { typography } from '../tokens/typography';

const PADDING = { top: 16, right: 16, bottom: 28, left: 44 };
const TARGET_SAMPLE_COUNT = 500;

interface ElevationProfileProps {
  trackPoints: TrackPoint[];
  waypoints?: TrailWaypoint[];
  /** Current GPS position in km along trail */
  currentKm?: number | null;
  /** Stable id of the focused waypoint */
  focusedWaypointId?: string | null;
  /** Called when user taps on the profile at a distance */
  onDistanceTap?: (km: number) => void;
  /** Visible km range from the map viewport [minKm, maxKm] */
  visibleRange?: [number, number] | null;
  /** Highlighted km range (e.g., a day's segment) — shown with accent fill */
  highlightedRange?: { startKm: number; endKm: number } | null;
  /** Water source km positions — shown as blue dots on the profile */
  waterSourceKms?: number[];
  /** Compact mode — reduced height, no gestures, no axis labels */
  compact?: boolean;
}

/** Color mapping for waypoint types on the profile */
const WAYPOINT_PROFILE_COLORS: Record<string, string> = {
  campsite: '#4CAF50',
  water: '#2196F3',
  'water-tank': '#2196F3',
  town: '#FF9800',
  shelter: '#795548',
  hut: '#795548',
};

function samplePoints(points: TrackPoint[], count: number): TrackPoint[] {
  if (points.length <= count) return points;
  const step = (points.length - 1) / (count - 1);
  const sampled: TrackPoint[] = [];
  for (let i = 0; i < count - 1; i++) {
    sampled.push(points[Math.round(i * step)]);
  }
  sampled.push(points[points.length - 1]);
  return sampled;
}

export function ElevationProfile({
  trackPoints,
  waypoints,
  currentKm,
  focusedWaypointId,
  onDistanceTap,
  visibleRange,
  highlightedRange,
  waterSourceKms,
  compact = false,
}: ElevationProfileProps) {
  const { colors } = useTheme();
  const [size, setSize] = useState({ width: 300, height: 200 });
  const [crosshair, setCrosshair] = useState<{ x: number; km: number; ele: number } | null>(null);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width > 0 && height > 0) {
      setSize({ width, height });
    }
  }, []);

  const sampledPoints = useMemo(() => samplePoints(trackPoints, TARGET_SAMPLE_COUNT), [trackPoints]);

  const chartMetrics = useMemo(() => {
    if (sampledPoints.length === 0) return null;
    const elevations = sampledPoints.map(p => p.ele);
    const { min: minEle, max: maxEle } = getMinMax(elevations);
    const maxDist = sampledPoints[sampledPoints.length - 1].dist;

    const eleTicks = niceAxisTicks(minEle, maxEle, 4);
    const distTicks = niceAxisTicks(0, maxDist, 5);

    const eleMin = eleTicks.length > 0 ? Math.min(minEle, eleTicks[0]) : minEle;
    const eleMax = eleTicks.length > 0 ? Math.max(maxEle, eleTicks[eleTicks.length - 1]) : maxEle;
    const eleRange = eleMax - eleMin || 1;
    const safeMaxDist = maxDist || 1;

    const chartWidth = size.width - PADDING.left - PADDING.right;
    const chartHeight = size.height - PADDING.top - PADDING.bottom;

    return { eleMin, eleMax, eleRange, maxDist: safeMaxDist, eleTicks, distTicks, chartWidth, chartHeight };
  }, [sampledPoints, size]);

  const elevationPath = useMemo(() => {
    if (!chartMetrics || sampledPoints.length === 0) return null;
    const { eleMin, eleRange, maxDist, chartWidth, chartHeight } = chartMetrics;
    const path = Skia.Path.Make();

    for (let i = 0; i < sampledPoints.length; i++) {
      const p = sampledPoints[i];
      const x = PADDING.left + (p.dist / maxDist) * chartWidth;
      const y = PADDING.top + chartHeight - ((p.ele - eleMin) / eleRange) * chartHeight;
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    }

    return path;
  }, [sampledPoints, chartMetrics]);

  const fillPath = useMemo(() => {
    if (!elevationPath || !chartMetrics) return null;
    const { chartWidth, chartHeight } = chartMetrics;
    const fill = elevationPath.copy();
    fill.lineTo(PADDING.left + chartWidth, PADDING.top + chartHeight);
    fill.lineTo(PADDING.left, PADDING.top + chartHeight);
    fill.close();
    return fill;
  }, [elevationPath, chartMetrics]);

  // Dispose native Skia Path objects when they are replaced or on unmount
  useEffect(() => {
    return () => {
      elevationPath?.dispose();
    };
  }, [elevationPath]);

  useEffect(() => {
    return () => {
      fillPath?.dispose();
    };
  }, [fillPath]);

  const gridLines = useMemo(() => {
    if (!chartMetrics) return [];
    const { eleMin, eleRange, eleTicks, maxDist, distTicks, chartWidth, chartHeight } = chartMetrics;
    const lines: { x1: number; y1: number; x2: number; y2: number }[] = [];

    for (const tick of eleTicks) {
      const y = PADDING.top + chartHeight - ((tick - eleMin) / eleRange) * chartHeight;
      lines.push({ x1: PADDING.left, y1: y, x2: PADDING.left + chartWidth, y2: y });
    }
    for (const tick of distTicks) {
      const x = PADDING.left + (tick / maxDist) * chartWidth;
      lines.push({ x1: x, y1: PADDING.top, x2: x, y2: PADDING.top + chartHeight });
    }
    return lines;
  }, [chartMetrics]);

  const waypointDots = useMemo(() => {
    if (!chartMetrics || !waypoints) return [];
    const { eleMin, eleRange, maxDist, chartWidth, chartHeight } = chartMetrics;
    return waypoints.reduce<{ x: number; y: number; color: string; id: string }[]>((acc, wp) => {
      if (wp.totalDistance != null && wp.elevation != null) {
        const x = PADDING.left + ((wp.totalDistance ?? 0) / maxDist) * chartWidth;
        const y = PADDING.top + chartHeight - (((wp.elevation ?? 0) - eleMin) / eleRange) * chartHeight;
        const color = WAYPOINT_PROFILE_COLORS[wp.type] ?? '#757575';
        acc.push({ x, y, color, id: wp.id });
      }
      return acc;
    }, []);
  }, [chartMetrics, waypoints]);

  const currentPositionX = useMemo(() => {
    if (!chartMetrics || currentKm == null) return null;
    return PADDING.left + (currentKm / chartMetrics.maxDist) * chartMetrics.chartWidth;
  }, [chartMetrics, currentKm]);

  const visibleRangeRect = useMemo(() => {
    if (!chartMetrics || !visibleRange) return null;
    const x1 = PADDING.left + (visibleRange[0] / chartMetrics.maxDist) * chartMetrics.chartWidth;
    const x2 = PADDING.left + (visibleRange[1] / chartMetrics.maxDist) * chartMetrics.chartWidth;
    return {
      x: Math.max(x1, PADDING.left),
      width: Math.min(x2, PADDING.left + chartMetrics.chartWidth) - Math.max(x1, PADDING.left),
    };
  }, [chartMetrics, visibleRange]);

  const highlightedRect = useMemo(() => {
    if (!chartMetrics || !highlightedRange) return null;
    const x1 = PADDING.left + (highlightedRange.startKm / chartMetrics.maxDist) * chartMetrics.chartWidth;
    const x2 = PADDING.left + (highlightedRange.endKm / chartMetrics.maxDist) * chartMetrics.chartWidth;
    return {
      x: Math.max(x1, PADDING.left),
      width: Math.min(x2, PADDING.left + chartMetrics.chartWidth) - Math.max(x1, PADDING.left),
    };
  }, [chartMetrics, highlightedRange]);

  const waterDots = useMemo(() => {
    if (!chartMetrics || !waterSourceKms || waterSourceKms.length === 0) return [];
    const { eleMin, eleRange, maxDist, chartWidth, chartHeight } = chartMetrics;
    return waterSourceKms
      .filter(km => km >= 0 && km <= maxDist)
      .map(km => {
        const x = PADDING.left + (km / maxDist) * chartWidth;
        // Find nearest elevation
        const idx = findNearestByDistance(sampledPoints, km);
        const ele = sampledPoints[idx]?.ele ?? 0;
        const y = PADDING.top + chartHeight - ((ele - eleMin) / eleRange) * chartHeight;
        return { x, y, km };
      });
  }, [chartMetrics, waterSourceKms, sampledPoints]);

  // Throttle crosshair state updates to ~20fps to avoid excessive re-renders
  const lastCrosshairUpdate = useRef(0);
  const CROSSHAIR_THROTTLE_MS = 50;

  const panGesture = useMemo(() => {
    return Gesture.Pan()
      .onUpdate((e) => {
        if (!chartMetrics) return;
        const now = Date.now();
        if (now - lastCrosshairUpdate.current < CROSSHAIR_THROTTLE_MS) return;
        lastCrosshairUpdate.current = now;
        const x = e.x;
        const km = ((x - PADDING.left) / chartMetrics.chartWidth) * chartMetrics.maxDist;
        if (km >= 0 && km <= chartMetrics.maxDist) {
          const idx = findNearestByDistance(sampledPoints, km);
          setCrosshair({
            x,
            km: sampledPoints[idx].dist,
            ele: sampledPoints[idx].ele,
          });
        }
      })
      .onEnd(() => {
        setCrosshair(null);
      });
  }, [chartMetrics, sampledPoints]);

  const tapGesture = useMemo(() => {
    return Gesture.Tap()
      .onEnd((e) => {
        if (!chartMetrics || !onDistanceTap) return;
        const km = ((e.x - PADDING.left) / chartMetrics.chartWidth) * chartMetrics.maxDist;
        if (km >= 0 && km <= chartMetrics.maxDist) {
          onDistanceTap(km);
        }
      });
  }, [chartMetrics, onDistanceTap]);

  const composed = useMemo(() => Gesture.Simultaneous(panGesture, tapGesture), [panGesture, tapGesture]);

  if (trackPoints.length === 0 || !chartMetrics) {
    return (
      <View style={[styles.empty, { backgroundColor: colors.surface }]}>
        <Text style={[styles.emptyText, { color: colors.textSecondary }]}>No elevation data</Text>
      </View>
    );
  }

  const canvasElement = (
    <Canvas style={{ width: size.width, height: compact ? 100 : size.height }}>
      {/* Grid lines */}
      <Group>
        {gridLines.map((line, i) => (
          <Line
            key={i}
            p1={vec(line.x1, line.y1)}
            p2={vec(line.x2, line.y2)}
            color="#e0e0e0"
            strokeWidth={0.5}
          />
        ))}
      </Group>

      {/* Visible map range highlight */}
      {visibleRangeRect && visibleRangeRect.width > 0 && (
        <Rect
          x={visibleRangeRect.x}
          y={PADDING.top}
          width={visibleRangeRect.width}
          height={chartMetrics.chartHeight}
          color="rgba(33, 150, 243, 0.08)"
        />
      )}

      {/* Highlighted range (day segment) */}
      {highlightedRect && highlightedRect.width > 0 && (
        <>
          <Rect
            x={highlightedRect.x}
            y={PADDING.top}
            width={highlightedRect.width}
            height={chartMetrics.chartHeight}
            color="rgba(103, 80, 164, 0.15)"
          />
          <Line
            p1={vec(highlightedRect.x, PADDING.top)}
            p2={vec(highlightedRect.x, PADDING.top + chartMetrics.chartHeight)}
            color="rgba(103, 80, 164, 0.6)"
            strokeWidth={1}
          />
          <Line
            p1={vec(highlightedRect.x + highlightedRect.width, PADDING.top)}
            p2={vec(highlightedRect.x + highlightedRect.width, PADDING.top + chartMetrics.chartHeight)}
            color="rgba(103, 80, 164, 0.6)"
            strokeWidth={1}
          />
        </>
      )}

      {/* Fill under curve */}
      {fillPath && (
        <Path path={fillPath}>
          <LinearGradient
            start={vec(0, PADDING.top)}
            end={vec(0, PADDING.top + chartMetrics.chartHeight)}
            colors={['rgba(76, 175, 80, 0.3)', 'rgba(76, 175, 80, 0.02)']}
          />
        </Path>
      )}

      {/* Elevation line */}
      {elevationPath && (
        <Path
          path={elevationPath}
          color="#4CAF50"
          style="stroke"
          strokeWidth={2}
          strokeCap="round"
          strokeJoin="round"
        />
      )}

      {/* Focused waypoint vertical indicator line */}
      {focusedWaypointId != null && waypointDots.find(d => d.id === focusedWaypointId) && (() => {
        const dot = waypointDots.find(d => d.id === focusedWaypointId)!;
        return (
          <Line
            p1={vec(dot.x, PADDING.top)}
            p2={vec(dot.x, PADDING.top + chartMetrics.chartHeight)}
            color={dot.color}
            strokeWidth={1.5}
            opacity={0.5}
          />
        );
      })()}

      {/* Waypoint dots */}
      {waypointDots.map((dot) => (
        <Circle
          key={dot.id}
          cx={dot.x}
          cy={dot.y}
          r={focusedWaypointId === dot.id ? 6 : 3}
          color={dot.color}
        />
      ))}

      {/* Water source dots */}
      {waterDots.map((dot, i) => (
        <Circle key={`water-${i}`} cx={dot.x} cy={dot.y} r={3} color="#2196F3" />
      ))}

      {/* Current position vertical line */}
      {currentPositionX != null && (
        <Line
          p1={vec(currentPositionX, PADDING.top)}
          p2={vec(currentPositionX, PADDING.top + chartMetrics.chartHeight)}
          color="#2196F3"
          strokeWidth={2}
        />
      )}

      {/* Crosshair */}
      {crosshair && (
        <Line
          p1={vec(crosshair.x, PADDING.top)}
          p2={vec(crosshair.x, PADDING.top + chartMetrics.chartHeight)}
          color="rgba(0,0,0,0.4)"
          strokeWidth={1}
        />
      )}
    </Canvas>
  );

  return (
    <View style={compact ? styles.compactContainer : styles.container} onLayout={onLayout}>
      {compact ? (
        canvasElement
      ) : (
        <GestureDetector gesture={composed}>
          {canvasElement}
        </GestureDetector>
      )}

      {/* Axis labels (rendered as RN Text for readability) */}
      {!compact && (
        <>
          <View style={styles.yLabels}>
            {chartMetrics.eleTicks.map((tick) => {
              const y = PADDING.top + chartMetrics.chartHeight - ((tick - chartMetrics.eleMin) / chartMetrics.eleRange) * chartMetrics.chartHeight;
              return (
                <Text
                  key={tick}
                  style={[styles.axisLabel, { color: colors.textSecondary, top: y - 6, left: 0 }]}
                >
                  {Math.round(tick)}m
                </Text>
              );
            })}
          </View>
          <View style={styles.xLabels}>
            {chartMetrics.distTicks.map((tick) => {
              const x = PADDING.left + (tick / chartMetrics.maxDist) * chartMetrics.chartWidth;
              return (
                <Text
                  key={tick}
                  style={[styles.axisLabel, { color: colors.textSecondary, left: x - 12, bottom: 0 }]}
                >
                  {Math.round(tick)}
                </Text>
              );
            })}
          </View>
        </>
      )}

      {/* Crosshair tooltip */}
      {!compact && crosshair && (
        <View
          style={[
            styles.tooltip,
            {
              left: Math.min(crosshair.x + 8, size.width - 100),
              top: PADDING.top,
              backgroundColor: colors.surface,
              borderColor: colors.border,
            },
          ]}
        >
          <Text style={[styles.tooltipText, { color: colors.textPrimary }]}>
            {crosshair.km.toFixed(1)} km, {Math.round(crosshair.ele)}m
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    position: 'relative',
  },
  compactContainer: {
    height: 100,
    position: 'relative',
  },
  empty: {
    height: 120,
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
    fontSize: 9,
    fontVariant: ['tabular-nums'],
  },
  tooltip: {
    position: 'absolute',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  tooltipText: {
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
});
