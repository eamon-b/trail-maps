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
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = (minFloat - min) * 60;
  return `${deg}°${String(min).padStart(2, '0')}'${sec.toFixed(1)}" ${hemisphere}`;
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
    flexShrink: 1,
  },
  feedback: {
    ...typography.caption,
    marginLeft: 'auto',
  },
  shareButton: {
    marginLeft: 'auto',
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
