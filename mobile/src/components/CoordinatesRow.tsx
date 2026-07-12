import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, Share, StyleSheet, Text, ViewStyle } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useTheme } from '../theme';
import { spacing, radii, touchTarget } from '../tokens/spacing';
import { typography } from '../tokens/typography';

export type CoordinateFormat = 'decimal' | 'dms';

interface CoordinatesRowProps {
  latitude: number;
  longitude: number;
  style?: ViewStyle;
}

/** Format one axis as degrees-minutes-seconds, e.g. 35°07'24.4" S */
function toDms(value: number, axis: 'lat' | 'lon'): string {
  const hemisphere =
    axis === 'lat' ? (value >= 0 ? 'N' : 'S') : (value >= 0 ? 'E' : 'W');
  const abs = Math.abs(value);
  let deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  let min = Math.floor(minFloat);
  // Round seconds to the displayed precision (0.1") FIRST, then propagate the
  // carry: without this, 35.999999 rounds to 35°59'60.0" instead of 36°00'00.0".
  let sec = Math.round((minFloat - min) * 60 * 10) / 10;
  if (sec >= 60) {
    sec -= 60;
    min += 1;
  }
  if (min >= 60) {
    min -= 60;
    deg += 1;
  }
  // Zero-pad seconds to match minutes (two integer digits): "00.0" .. "59.9".
  const secStr = sec.toFixed(1).padStart(4, '0');
  return `${deg}°${String(min).padStart(2, '0')}'${secStr}" ${hemisphere}`;
}

/** Format a coordinate pair in the given format (decimal = 5 dp). */
export function formatCoordinates(
  latitude: number,
  longitude: number,
  format: CoordinateFormat,
): string {
  if (format === 'dms') {
    return `${toDms(latitude, 'lat')} ${toDms(longitude, 'lon')}`;
  }
  return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
}

/**
 * Compact current-position readout for the hike dashboard.
 *
 * - Tap copies the coordinate string to the clipboard (with confirmation).
 * - The share icon opens the OS share sheet (relaying position to rescue or
 *   a mate over any messaging app).
 * - Long-press toggles between decimal degrees and DMS.
 */
export function CoordinatesRow({ latitude, longitude, style }: CoordinatesRowProps) {
  const { colors } = useTheme();
  const [format, setFormat] = useState<CoordinateFormat>('decimal');
  const [feedback, setFeedback] = useState<string | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const coordText = formatCoordinates(latitude, longitude, format);

  const showFeedback = useCallback((text: string) => {
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    setFeedback(text);
    feedbackTimer.current = setTimeout(() => setFeedback(null), 2000);
  }, []);

  useEffect(() => {
    return () => {
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    };
  }, []);

  const handlePress = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(coordText);
      showFeedback('Copied');
    } catch {
      // Clipboard unavailable — nothing to do
    }
  }, [coordText, showFeedback]);

  const handleShare = useCallback(async () => {
    try {
      const result = await Share.share({ message: coordText });
      if (result.action === Share.sharedAction) {
        showFeedback('Shared');
      }
    } catch {
      // Share sheet unavailable/dismissed — nothing to do
    }
  }, [coordText, showFeedback]);

  const handleLongPress = useCallback(() => {
    const next: CoordinateFormat = format === 'decimal' ? 'dms' : 'decimal';
    setFormat(next);
    showFeedback(next === 'dms' ? 'Format: DMS' : 'Format: decimal');
  }, [format, showFeedback]);

  return (
    <Pressable
      onPress={handlePress}
      onLongPress={handleLongPress}
      style={[styles.row, { borderColor: colors.border }, style]}
      accessibilityRole="button"
      accessibilityLabel={`Current coordinates ${coordText}. Tap to copy, long press to change format.`}
    >
      <Text style={styles.icon}>📍</Text>
      <Text
        style={[styles.coords, { color: colors.textPrimary }]}
        numberOfLines={1}
      >
        {coordText}
      </Text>
      {feedback && (
        <Text style={[styles.feedback, { color: colors.textSecondary }]}>
          {feedback}
        </Text>
      )}
      <Pressable
        onPress={handleShare}
        style={styles.shareButton}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Share coordinates"
      >
        <Text style={[styles.shareIcon, { color: colors.accent }]}>↗</Text>
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: touchTarget.min,
    paddingHorizontal: spacing.md,
    borderRadius: radii.lg,
    borderWidth: 1,
    gap: spacing.sm,
  },
  icon: {
    fontSize: 14,
  },
  coords: {
    ...typography.body,
    fontVariant: ['tabular-nums'],
    // Grow to absorb all free space so the trailing feedback + share button
    // pack at the right edge. When the "Copied" feedback appears/disappears
    // the coords text flexes to accommodate it, so the share icon stays put
    // (previously both feedback and shareButton had `marginLeft: auto`, which
    // split the free space between them and made the icon jump).
    flex: 1,
  },
  feedback: {
    ...typography.caption,
  },
  shareButton: {
    minWidth: 32,
    minHeight: touchTarget.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shareIcon: {
    fontSize: 18,
    fontWeight: '700',
  },
});
