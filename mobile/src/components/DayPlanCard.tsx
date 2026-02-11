import React, { useCallback } from 'react';
import { Dimensions, Pressable, StyleSheet, Text, View, ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useTheme } from '../theme';
import { useReduceMotion } from '../theme/useReduceMotion';
import { ClimateCard } from './ClimateCard';
import { springConfigs, timingConfigs } from '../tokens/motion';
import { spacing, touchTarget, radii } from '../tokens/spacing';
import { typography } from '../tokens/typography';

const SCREEN_WIDTH = Dimensions.get('window').width;
const SWIPE_THRESHOLD = SCREEN_WIDTH * 0.4;

export interface DayPlanData {
  dayNumber: number;
  date?: string;
  startName: string;
  endName: string;
  distanceKm: number;
  ascentM: number;
  descentM: number;
  estimatedHours?: number;
  waterSources?: number;
}

interface DayClimate {
  tempMin: number;
  tempMax: number;
  precipitation: number;
  rainyDays: number;
}

interface DayPlanCardProps {
  data: DayPlanData;
  /** Called when card is swiped to remove */
  onRemove?: () => void;
  /** Called when merge-up button is tapped */
  onMergeUp?: () => void;
  /** Called when split button is tapped */
  onSplit?: () => void;
  /** Called when map pin button is tapped to show on map */
  onShowOnMap?: () => void;
  /** Called on long press to relocate stop */
  onLongPress?: () => void;
  /** Climate data for this day */
  climate?: DayClimate | null;
  style?: ViewStyle;
}

/**
 * Day Plan card with gesture interactions:
 * - Drag reorder from ≡ handle only (not entire card)
 * - Swipe left past 40% to remove with snap-back if threshold not met
 * - Merge ↑ and Split ↓ buttons with 44×44pt touch targets
 */
export function DayPlanCard({
  data,
  onRemove,
  onMergeUp,
  onSplit,
  onShowOnMap,
  onLongPress,
  climate,
  style,
}: DayPlanCardProps) {
  const { colors, highContrast } = useTheme();
  const reduceMotion = useReduceMotion();
  const translateX = useSharedValue(0);

  const handleRemove = useCallback(() => {
    onRemove?.();
  }, [onRemove]);

  const handleLongPress = useCallback(() => {
    onLongPress?.();
  }, [onLongPress]);

  // Long press gesture
  const longPressGesture = Gesture.LongPress()
    .minDuration(500)
    .onEnd((_event, success) => {
      if (success) {
        runOnJS(handleLongPress)();
      }
    });

  // Swipe-to-remove gesture
  const swipeGesture = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .failOffsetY([-5, 5])
    .onUpdate((event) => {
      // Only allow swiping left
      if (event.translationX < 0) {
        translateX.value = event.translationX;
      }
    })
    .onEnd((event) => {
      if (event.translationX < -SWIPE_THRESHOLD) {
        // Past threshold — animate out and remove
        if (reduceMotion) {
          translateX.value = -SCREEN_WIDTH;
          runOnJS(handleRemove)();
        } else {
          translateX.value = withTiming(-SCREEN_WIDTH, timingConfigs.slideIn, (finished) => {
            if (finished) {
              runOnJS(handleRemove)();
            }
          });
        }
      } else {
        // Snap back
        translateX.value = reduceMotion
          ? 0
          : withSpring(0, springConfigs.cardReorder);
      }
    });

  const swipeStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const {
    dayNumber, date, startName, endName,
    distanceKm, ascentM, descentM, estimatedHours,
    waterSources,
  } = data;

  const composedGesture = onLongPress
    ? Gesture.Race(swipeGesture, longPressGesture)
    : swipeGesture;

  return (
    <GestureDetector gesture={composedGesture}>
      <Animated.View
        style={[
          styles.card,
          {
            backgroundColor: highContrast ? colors.background : colors.surface,
            borderColor: colors.border,
            borderWidth: highContrast ? 1.5 : StyleSheet.hairlineWidth,
            elevation: 2,
          },
          swipeStyle,
          style,
        ]}
        accessibilityLabel={`Day ${dayNumber}${date ? `, ${date}` : ''}. ${startName} to ${endName}. ${distanceKm} kilometers, ${ascentM} meters ascent, ${descentM} meters descent.${estimatedHours ? ` About ${estimatedHours} hours.` : ''}${waterSources ? ` ${waterSources} water sources.` : ''}`}
        accessibilityRole="summary"
      >
        {/* Header row */}
        <View style={styles.headerRow}>
          <View style={styles.headerText}>
            <Text style={[styles.dayLabel, { color: colors.textPrimary }]}>
              DAY {dayNumber}{date ? ` — ${date}` : ''}
            </Text>
            <Text style={[styles.routeText, { color: colors.textSecondary }]}>
              {startName} → {endName}
            </Text>
          </View>
        </View>

        {/* Stats row */}
        <Text style={[styles.stats, { color: colors.textPrimary }]}>
          {distanceKm.toFixed(1)} km  +{ascentM}m/-{descentM}m{estimatedHours ? `  ~${estimatedHours}h` : ''}
        </Text>

        {/* Water sources */}
        {waterSources != null && waterSources > 0 && (
          <Text style={[styles.waterText, { color: colors.textSecondary }]}>
            💧 {waterSources} water source{waterSources > 1 ? 's' : ''}
          </Text>
        )}

        {/* Climate data */}
        {climate && (
          <ClimateCard
            tempMin={climate.tempMin}
            tempMax={climate.tempMax}
            precipitation={climate.precipitation}
            rainyDays={climate.rainyDays}
            style={styles.climateCard}
          />
        )}

        {/* Action buttons row */}
        <View style={styles.actionsRow}>
          {onShowOnMap && (
            <Pressable
              onPress={onShowOnMap}
              style={styles.actionButton}
              accessibilityLabel="Show on map"
              accessibilityRole="button"
            >
              <Text style={[styles.actionIcon, { color: colors.accent }]}>📍</Text>
            </Pressable>
          )}
          <View style={{ flex: 1 }} />
          {onMergeUp && (
            <Pressable
              onPress={onMergeUp}
              style={styles.actionButton}
              accessibilityLabel="Merge with previous day"
              accessibilityRole="button"
            >
              <Text style={[styles.actionIcon, { color: colors.textSecondary }]}>↑</Text>
            </Pressable>
          )}
          {onSplit && (
            <Pressable
              onPress={onSplit}
              style={styles.actionButton}
              accessibilityLabel="Split this day"
              accessibilityRole="button"
            >
              <Text style={[styles.actionIcon, { color: colors.textSecondary }]}>↓</Text>
            </Pressable>
          )}
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radii.lg,
    padding: spacing.lg,
    marginBottom: spacing.md,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: spacing.sm,
  },
  headerText: {
    flex: 1,
  },
  dayLabel: {
    ...typography.titleLarge,
    marginBottom: spacing.xs,
  },
  routeText: {
    ...typography.body,
  },
  stats: {
    ...typography.body,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    marginBottom: spacing.xs,
  },
  waterText: {
    ...typography.caption,
    marginBottom: spacing.xs,
  },
  climateCard: {
    marginBottom: spacing.xs,
  },
  actionsRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  actionButton: {
    width: touchTarget.min,
    height: touchTarget.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionIcon: {
    fontSize: 22,
    fontWeight: '700',
  },
});
