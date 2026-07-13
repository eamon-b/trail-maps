import React, { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View, ViewStyle, useWindowDimensions } from 'react-native';
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
import { PressableRow } from './PressableRow';
import { triggerHaptic } from './haptics';
import { springConfigs, timingConfigs } from '../tokens/motion';
import { spacing, touchTarget, radii } from '../tokens/spacing';
import { glyphSizes, typography } from '../tokens/typography';

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

/** Per-day water/resupply summary shown as a compact strip on the card */
export interface DayResources {
  /** Longest water carry (km) intersecting this day, or null when unknown */
  maxCarryKm?: number | null;
  /** Whether a resupply point (town/food) falls within this day */
  hasResupply?: boolean;
}

interface DayPlanCardProps {
  data: DayPlanData;
  /** Called when card is swiped to remove */
  onRemove?: () => void;
  /** Called when the ⋯ menu button is tapped (opens the day action sheet) */
  onOpenMenu?: () => void;
  /** Called when map pin button is tapped to show on map */
  onShowOnMap?: () => void;
  /** Called on long press to relocate stop */
  onLongPress?: () => void;
  /** Climate data for this day */
  climate?: DayClimate | null;
  /** Water-carry / resupply summary for the strip */
  resources?: DayResources;
  /** Tap-through from the resource strip to the full water/resupply lists */
  onResourcePress?: () => void;
  style?: ViewStyle;
}

/**
 * Day Plan card. Editing verbs live in a labeled ⋯ menu (opened via
 * onOpenMenu); gestures remain as shortcuts:
 * - Swipe left past 40% to remove with snap-back if threshold not met
 * - Long-press to relocate the stop on the map
 */
export function DayPlanCard({
  data,
  onRemove,
  onOpenMenu,
  onShowOnMap,
  onLongPress,
  climate,
  resources,
  onResourcePress,
  style,
}: DayPlanCardProps) {
  const { colors, highContrast } = useTheme();
  const reduceMotion = useReduceMotion();
  const { width: screenWidth } = useWindowDimensions();
  const swipeThreshold = screenWidth * 0.4;
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
      if (event.translationX < -swipeThreshold) {
        // Past threshold — fire the destructive-swipe warning once at commit
        // (in onEnd, so it fires per removal, not per frame), then animate out.
        runOnJS(triggerHaptic)('warning');
        // Past threshold — animate out and remove
        if (reduceMotion) {
          translateX.value = -screenWidth;
          runOnJS(handleRemove)();
        } else {
          translateX.value = withTiming(-screenWidth, timingConfigs.slideIn, (finished) => {
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

        {/* Water / resupply strip — tap through to the full lists */}
        {(waterSources != null || resources) && (
          <Pressable
            onPress={onResourcePress}
            disabled={!onResourcePress}
            accessibilityRole={onResourcePress ? 'button' : undefined}
            accessibilityLabel={buildResourceLabel(waterSources, resources)}
            accessibilityHint={onResourcePress ? 'Shows water and resupply details' : undefined}
            style={styles.resourceStrip}
          >
            <Text style={[styles.waterText, { color: colors.textSecondary }]} numberOfLines={1}>
              {buildResourceText(waterSources, resources)}
            </Text>
          </Pressable>
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
            <PressableRow
              onPress={onShowOnMap}
              style={styles.actionButton}
              accessibilityLabel="Show on map"
            >
              <Text style={[styles.actionIcon, { color: colors.accent }]}>📍</Text>
            </PressableRow>
          )}
          <View style={{ flex: 1 }} />
          {onOpenMenu && (
            <PressableRow
              onPress={onOpenMenu}
              style={styles.actionButton}
              accessibilityLabel={`Day ${dayNumber} actions`}
              accessibilityHint="Split, merge, move, or remove this day's stop"
            >
              <Text style={[styles.actionIcon, { color: colors.textSecondary }]}>⋯</Text>
            </PressableRow>
          )}
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

function buildResourceText(waterSources?: number, resources?: DayResources): string {
  const parts: string[] = [];
  if (waterSources != null && waterSources > 0) {
    parts.push(`💧 ${waterSources} water source${waterSources > 1 ? 's' : ''}`);
  } else if (waterSources === 0 || resources?.maxCarryKm != null) {
    parts.push('💧 no water');
  }
  if (resources?.maxCarryKm != null && resources.maxCarryKm > 0) {
    parts.push(`carry ${resources.maxCarryKm.toFixed(0)} km`);
  }
  if (resources?.hasResupply) {
    parts.push('🛒 resupply');
  }
  return parts.join('  ·  ');
}

function buildResourceLabel(waterSources?: number, resources?: DayResources): string {
  const parts: string[] = [];
  if (waterSources != null) {
    parts.push(`${waterSources} water source${waterSources === 1 ? '' : 's'}`);
  }
  if (resources?.maxCarryKm != null && resources.maxCarryKm > 0) {
    parts.push(`longest water carry ${resources.maxCarryKm.toFixed(0)} kilometers`);
  }
  if (resources?.hasResupply) {
    parts.push('resupply available');
  }
  return parts.join(', ') || 'Water and resupply details';
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
  resourceStrip: {
    marginBottom: spacing.xs,
    minHeight: spacing.xl,
    justifyContent: 'center',
  },
  waterText: {
    ...typography.dataSmall,
    fontWeight: '400',
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
    // Fixed width keeps the icon buttons square; minHeight (not a fixed
    // height) lets the glyph grow with the font-scale clamp without clipping.
    width: touchTarget.min,
    minHeight: touchTarget.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionIcon: {
    fontSize: glyphSizes.lg,
    fontWeight: '700',
  },
});
