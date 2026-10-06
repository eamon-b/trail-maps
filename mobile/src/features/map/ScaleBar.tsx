/**
 * Always-on map scale bar.
 *
 * MapLibre's own `scaleBar` ornament is not used: on iOS it fades out once the
 * camera stops moving, and on Android it can only sit top-left, under the
 * status pill. This one is drawn by us, follows the theme and the user's
 * distance unit, and never hides.
 *
 * The camera moves every frame during a gesture, so the pane pushes camera
 * updates in through the imperative `update()` rather than as props: only this
 * small view re-renders, never the map.
 */

import React, { forwardRef, useImperativeHandle, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { DistanceUnit } from '@lib/format-distance';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';
import { scaleBarFor } from './map-scale';

/** The longest the bar may grow, in points. */
export const SCALE_BAR_MAX_WIDTH = 100;

export interface ScaleBarHandle {
  /** Feed the current camera: zoom level and the latitude at its centre. */
  update: (zoom: number, latitude: number) => void;
}

export interface ScaleBarProps {
  unit: DistanceUnit;
}

interface Camera {
  zoom: number;
  latitude: number;
}

export const ScaleBar = forwardRef<ScaleBarHandle, ScaleBarProps>(function ScaleBar(
  { unit },
  ref,
) {
  const { colors } = useTheme();
  const [camera, setCamera] = useState<Camera | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      update: (zoom, latitude) =>
        setCamera((prev) =>
          prev && prev.zoom === zoom && prev.latitude === latitude ? prev : { zoom, latitude },
        ),
    }),
    [],
  );

  // Nothing to measure until the camera has reported once.
  const spec = camera
    ? scaleBarFor(camera.zoom, camera.latitude, unit, SCALE_BAR_MAX_WIDTH)
    : null;
  if (!spec) return null;

  return (
    <View
      style={[styles.root, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}
      pointerEvents="none"
      accessibilityRole="text"
      accessibilityLabel={`Map scale: ${spec.label}`}
      testID="map-scale-bar"
    >
      <Text style={[styles.label, { color: colors.textPrimary }]}>{spec.label}</Text>
      <View
        style={[styles.bar, { width: spec.width, borderColor: colors.textPrimary }]}
        testID="map-scale-bar-line"
      />
    </View>
  );
});

const styles = StyleSheet.create({
  root: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  label: {
    ...typography.caption,
    fontWeight: '600',
  },
  // A bracket: bottom rule with short end ticks, the conventional scale glyph.
  bar: {
    height: 6,
    borderLeftWidth: 2,
    borderRightWidth: 2,
    borderBottomWidth: 2,
  },
});
