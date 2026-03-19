import React, { useCallback, useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTheme } from '../theme';
import type { Trail, TrailWaypoint } from '../lib/trail-utils';
import type { SectionConfig } from '../services/plan-calculator-types';
import { waypointEmojis } from './WaypointList';
import { spacing, touchTarget, radii } from '../tokens/spacing';
import { typography } from '../tokens/typography';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Mode = 'full' | 'section';
type PickerTarget = 'start' | 'end';

interface SectionSelectorProps {
  trail: Trail;
  currentSection: SectionConfig | null;
  onApply: (section: SectionConfig | null) => void;
  onDismiss: () => void;
  /** Called when "Select on map" is tapped */
  onSelectOnMap?: () => void;
}

// Waypoint types eligible for section boundary selection
const ELIGIBLE_TYPES = new Set([
  'town',
  'trailhead',
  'road',
  'carpark',
  'campsite',
  'hut',
  'shelter',
]);

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Section selector for choosing section-hiking boundaries on a trail.
 *
 * Provides a "Full Trail" / "Section" toggle. When "Section" is active,
 * shows two searchable waypoint pickers (start and end) plus optional
 * direct km entry inputs. Displays a distance summary and an Apply button.
 */
export function SectionSelector({
  trail,
  currentSection,
  onApply,
  onDismiss,
  onSelectOnMap,
}: SectionSelectorProps) {
  const { colors } = useTheme();

  // Mode: "full" for entire trail, "section" for custom boundaries
  const [mode, setMode] = useState<Mode>(currentSection ? 'section' : 'full');

  // Which picker is currently expanded (null = neither)
  const [activePicker, setActivePicker] = useState<PickerTarget | null>(null);

  // Search text per picker
  const [startSearch, setStartSearch] = useState('');
  const [endSearch, setEndSearch] = useState('');

  // Direct km entry strings
  const [startKmText, setStartKmText] = useState(
    currentSection ? currentSection.startKm.toFixed(1) : '',
  );
  const [endKmText, setEndKmText] = useState(
    currentSection ? currentSection.endKm.toFixed(1) : '',
  );

  // Selected waypoints / km values
  const [startKm, setStartKm] = useState<number>(
    currentSection ? currentSection.startKm : 0,
  );
  const [startName, setStartName] = useState<string>(
    currentSection
      ? currentSection.startName
      : trail.waypoints[0]?.name ?? 'Start',
  );
  const [endKm, setEndKm] = useState<number>(
    currentSection ? currentSection.endKm : trail.track.totalDistance,
  );
  const [endName, setEndName] = useState<string>(
    currentSection
      ? currentSection.endName
      : trail.waypoints[trail.waypoints.length - 1]?.name ?? 'End',
  );

  // Eligible waypoints for selection
  const eligibleWaypoints = useMemo(
    () => trail.waypoints.filter(wp => ELIGIBLE_TYPES.has(wp.type)),
    [trail.waypoints],
  );

  // Filtered lists based on search text
  const filteredStart = useMemo(() => {
    if (!startSearch.trim()) return eligibleWaypoints;
    const q = startSearch.trim().toLowerCase();
    return eligibleWaypoints.filter(wp => wp.name.toLowerCase().includes(q));
  }, [eligibleWaypoints, startSearch]);

  const filteredEnd = useMemo(() => {
    if (!endSearch.trim()) return eligibleWaypoints;
    const q = endSearch.trim().toLowerCase();
    return eligibleWaypoints.filter(wp => wp.name.toLowerCase().includes(q));
  }, [eligibleWaypoints, endSearch]);

  // Section distance
  const sectionDistance = useMemo(() => {
    if (mode === 'full') return trail.track.totalDistance;
    const dist = endKm - startKm;
    return Math.max(0, Math.round(dist * 10) / 10);
  }, [mode, startKm, endKm, trail.track.totalDistance]);

  // Whether the current section configuration is valid
  const isValid = useMemo(() => {
    if (mode === 'full') return true;
    return startKm < endKm && startKm >= 0 && endKm <= trail.track.totalDistance;
  }, [mode, startKm, endKm, trail.track.totalDistance]);

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  const handleSelectWaypoint = useCallback(
    (wp: TrailWaypoint, target: PickerTarget) => {
      const km = wp.totalDistance ?? 0;
      if (target === 'start') {
        setStartKm(km);
        setStartName(wp.name);
        setStartKmText(km.toFixed(1));
      } else {
        setEndKm(km);
        setEndName(wp.name);
        setEndKmText(km.toFixed(1));
      }
      setActivePicker(null);
    },
    [],
  );

  const handleStartKmSubmit = useCallback(() => {
    const parsed = parseFloat(startKmText);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= trail.track.totalDistance) {
      setStartKm(parsed);
      // Try to find a matching waypoint for the name
      const nearest = findNearestWaypoint(parsed, trail.waypoints);
      setStartName(nearest ? nearest.name : `km ${parsed.toFixed(1)}`);
    }
  }, [startKmText, trail.track.totalDistance, trail.waypoints]);

  const handleEndKmSubmit = useCallback(() => {
    const parsed = parseFloat(endKmText);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= trail.track.totalDistance) {
      setEndKm(parsed);
      const nearest = findNearestWaypoint(parsed, trail.waypoints);
      setEndName(nearest ? nearest.name : `km ${parsed.toFixed(1)}`);
    }
  }, [endKmText, trail.track.totalDistance, trail.waypoints]);

  const handleApply = useCallback(() => {
    if (mode === 'full') {
      onApply(null);
    } else if (isValid) {
      onApply({ startKm, endKm, startName, endName });
    }
  }, [mode, isValid, startKm, endKm, startName, endName, onApply]);

  // -------------------------------------------------------------------------
  // Render helpers
  // -------------------------------------------------------------------------

  const renderWaypointItem = useCallback(
    (target: PickerTarget) =>
      ({ item }: { item: TrailWaypoint }) => {
        const km = item.totalDistance ?? 0;
        const emoji = waypointEmojis[item.type] ?? waypointEmojis.poi;
        const isSelected =
          target === 'start'
            ? km === startKm && item.name === startName
            : km === endKm && item.name === endName;

        return (
          <Pressable
            onPress={() => handleSelectWaypoint(item, target)}
            style={[
              styles.row,
              {
                backgroundColor: isSelected ? colors.accentSubtle : 'transparent',
                borderColor: isSelected ? colors.accent : colors.border,
              },
            ]}
            accessibilityLabel={`${item.name}, ${km.toFixed(1)} km${isSelected ? ', selected' : ''}`}
            accessibilityRole="button"
          >
            <Text style={styles.emoji}>{emoji}</Text>
            <View style={styles.rowContent}>
              <Text
                style={[styles.rowName, { color: colors.textPrimary }]}
                numberOfLines={1}
              >
                {item.name}
              </Text>
              <Text style={[styles.rowKm, { color: colors.textSecondary }]}>
                km {km.toFixed(1)}
              </Text>
            </View>
            {isSelected && (
              <Text style={[styles.check, { color: colors.accent }]}>✓</Text>
            )}
          </Pressable>
        );
      },
    [startKm, startName, endKm, endName, handleSelectWaypoint, colors],
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <View style={styles.container}>
      {/* Header */}
      <Text style={[styles.header, { color: colors.textPrimary }]}>
        Section Boundaries
      </Text>
      <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
        Hike the full trail or define a section.
      </Text>

      {/* Segmented toggle */}
      <View style={[styles.toggle, { borderColor: colors.border }]}>
        <Pressable
          onPress={() => setMode('full')}
          style={[
            styles.toggleOption,
            {
              backgroundColor: mode === 'full' ? colors.accent : 'transparent',
            },
          ]}
          accessibilityRole="button"
          accessibilityState={{ selected: mode === 'full' }}
          accessibilityLabel="Full Trail"
        >
          <Text
            style={[
              styles.toggleText,
              { color: mode === 'full' ? colors.textInverse : colors.textPrimary },
            ]}
          >
            Full Trail
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setMode('section')}
          style={[
            styles.toggleOption,
            {
              backgroundColor: mode === 'section' ? colors.accent : 'transparent',
            },
          ]}
          accessibilityRole="button"
          accessibilityState={{ selected: mode === 'section' }}
          accessibilityLabel="Section"
        >
          <Text
            style={[
              styles.toggleText,
              {
                color:
                  mode === 'section' ? colors.textInverse : colors.textPrimary,
              },
            ]}
          >
            Section
          </Text>
        </Pressable>
      </View>

      {/* Section pickers (only when mode === 'section') */}
      {mode === 'section' && (
        <View style={styles.sectionBody}>
          {/* Start Point */}
          <View style={styles.pickerSection}>
            <Text style={[styles.pickerLabel, { color: colors.textSecondary }]}>
              Start Point
            </Text>
            <Pressable
              onPress={() =>
                setActivePicker(activePicker === 'start' ? null : 'start')
              }
              style={[
                styles.pickerValue,
                {
                  borderColor:
                    activePicker === 'start' ? colors.accent : colors.border,
                  backgroundColor: colors.surface,
                },
              ]}
              accessibilityLabel={`Start point: ${startName}, km ${startKm.toFixed(1)}`}
              accessibilityRole="button"
            >
              <Text
                style={[styles.pickerValueText, { color: colors.textPrimary }]}
                numberOfLines={1}
              >
                {startName}
              </Text>
              <Text
                style={[styles.pickerValueKm, { color: colors.textSecondary }]}
              >
                km {startKm.toFixed(1)}
              </Text>
            </Pressable>

            {activePicker === 'start' && (
              <View style={styles.pickerDropdown}>
                <TextInput
                  style={[
                    styles.searchInput,
                    {
                      color: colors.textPrimary,
                      backgroundColor: colors.surface,
                      borderColor: colors.border,
                    },
                  ]}
                  value={startSearch}
                  onChangeText={setStartSearch}
                  placeholder="Search waypoints..."
                  placeholderTextColor={colors.textSecondary}
                  autoCorrect={false}
                  clearButtonMode="while-editing"
                  accessibilityLabel="Search start waypoints"
                />
                {/* Direct km entry */}
                <View style={styles.kmEntryRow}>
                  <Text
                    style={[styles.kmEntryLabel, { color: colors.textSecondary }]}
                  >
                    Enter km
                  </Text>
                  <TextInput
                    style={[
                      styles.kmEntryInput,
                      {
                        color: colors.textPrimary,
                        backgroundColor: colors.surface,
                        borderColor: colors.border,
                      },
                    ]}
                    value={startKmText}
                    onChangeText={setStartKmText}
                    onSubmitEditing={handleStartKmSubmit}
                    onBlur={handleStartKmSubmit}
                    keyboardType="decimal-pad"
                    returnKeyType="done"
                    placeholder="0.0"
                    placeholderTextColor={colors.textSecondary}
                    accessibilityLabel="Start km value"
                  />
                </View>
                <FlatList
                  data={filteredStart}
                  keyExtractor={(item) =>
                    `start-${item.name}-${item.totalDistance ?? 0}`
                  }
                  renderItem={renderWaypointItem('start')}
                  style={styles.waypointList}
                  keyboardShouldPersistTaps="handled"
                  nestedScrollEnabled
                />
              </View>
            )}
          </View>

          {/* End Point */}
          <View style={styles.pickerSection}>
            <Text style={[styles.pickerLabel, { color: colors.textSecondary }]}>
              End Point
            </Text>
            <Pressable
              onPress={() =>
                setActivePicker(activePicker === 'end' ? null : 'end')
              }
              style={[
                styles.pickerValue,
                {
                  borderColor:
                    activePicker === 'end' ? colors.accent : colors.border,
                  backgroundColor: colors.surface,
                },
              ]}
              accessibilityLabel={`End point: ${endName}, km ${endKm.toFixed(1)}`}
              accessibilityRole="button"
            >
              <Text
                style={[styles.pickerValueText, { color: colors.textPrimary }]}
                numberOfLines={1}
              >
                {endName}
              </Text>
              <Text
                style={[styles.pickerValueKm, { color: colors.textSecondary }]}
              >
                km {endKm.toFixed(1)}
              </Text>
            </Pressable>

            {activePicker === 'end' && (
              <View style={styles.pickerDropdown}>
                <TextInput
                  style={[
                    styles.searchInput,
                    {
                      color: colors.textPrimary,
                      backgroundColor: colors.surface,
                      borderColor: colors.border,
                    },
                  ]}
                  value={endSearch}
                  onChangeText={setEndSearch}
                  placeholder="Search waypoints..."
                  placeholderTextColor={colors.textSecondary}
                  autoCorrect={false}
                  clearButtonMode="while-editing"
                  accessibilityLabel="Search end waypoints"
                />
                {/* Direct km entry */}
                <View style={styles.kmEntryRow}>
                  <Text
                    style={[styles.kmEntryLabel, { color: colors.textSecondary }]}
                  >
                    Enter km
                  </Text>
                  <TextInput
                    style={[
                      styles.kmEntryInput,
                      {
                        color: colors.textPrimary,
                        backgroundColor: colors.surface,
                        borderColor: colors.border,
                      },
                    ]}
                    value={endKmText}
                    onChangeText={setEndKmText}
                    onSubmitEditing={handleEndKmSubmit}
                    onBlur={handleEndKmSubmit}
                    keyboardType="decimal-pad"
                    returnKeyType="done"
                    placeholder="0.0"
                    placeholderTextColor={colors.textSecondary}
                    accessibilityLabel="End km value"
                  />
                </View>
                <FlatList
                  data={filteredEnd}
                  keyExtractor={(item) =>
                    `end-${item.name}-${item.totalDistance ?? 0}`
                  }
                  renderItem={renderWaypointItem('end')}
                  style={styles.waypointList}
                  keyboardShouldPersistTaps="handled"
                  nestedScrollEnabled
                />
              </View>
            )}
          </View>

          {/* Select on map button */}
          {onSelectOnMap && (
            <Pressable
              onPress={onSelectOnMap}
              style={[styles.selectOnMapButton, { borderColor: colors.accent }]}
              accessibilityLabel="Select section on map"
              accessibilityRole="button"
            >
              <Text style={[styles.selectOnMapText, { color: colors.accent }]}>
                Select on Map
              </Text>
            </Pressable>
          )}
        </View>
      )}

      {/* Summary line */}
      <View style={[styles.summary, { borderColor: colors.border }]}>
        <Text style={[styles.summaryLabel, { color: colors.textSecondary }]}>
          {mode === 'full' ? 'Total distance' : 'Section distance'}
        </Text>
        <Text style={[styles.summaryValue, { color: colors.textPrimary }]}>
          {sectionDistance.toFixed(1)} km
        </Text>
      </View>

      {/* Validation error */}
      {mode === 'section' && !isValid && (
        <Text style={[styles.errorText, { color: colors.alertRed }]}>
          Start point must be before end point.
        </Text>
      )}

      {/* Action buttons */}
      <View style={styles.actions}>
        <Pressable
          onPress={onDismiss}
          style={[styles.button, styles.cancelButton, { borderColor: colors.border }]}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
        >
          <Text style={[styles.buttonText, { color: colors.textPrimary }]}>
            Cancel
          </Text>
        </Pressable>
        <Pressable
          onPress={handleApply}
          disabled={!isValid}
          style={[
            styles.button,
            styles.applyButton,
            {
              backgroundColor: isValid ? colors.accent : colors.accentMuted,
            },
          ]}
          accessibilityRole="button"
          accessibilityLabel="Apply section"
          accessibilityState={{ disabled: !isValid }}
        >
          <Text style={[styles.buttonText, { color: colors.textInverse }]}>
            Apply
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find the nearest waypoint to a given km position. Returns null if none close. */
function findNearestWaypoint(
  km: number,
  waypoints: TrailWaypoint[],
): TrailWaypoint | null {
  let best: TrailWaypoint | null = null;
  let bestDist = Infinity;
  for (const wp of waypoints) {
    const d = Math.abs((wp.totalDistance ?? 0) - km);
    if (d < bestDist) {
      bestDist = d;
      best = wp;
    }
  }
  // Only match if within 0.5 km
  return bestDist <= 0.5 ? best : null;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    paddingVertical: spacing.md,
  },
  header: {
    ...typography.titleLarge,
    marginBottom: spacing.xs,
  },
  subtitle: {
    ...typography.caption,
    marginBottom: spacing.md,
  },

  // Segmented toggle
  toggle: {
    flexDirection: 'row',
    borderWidth: 1,
    borderRadius: radii.md,
    overflow: 'hidden',
    marginBottom: spacing.lg,
  },
  toggleOption: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: touchTarget.min,
    paddingVertical: spacing.sm,
  },
  toggleText: {
    ...typography.body,
    fontWeight: '600',
  },

  // Section body
  sectionBody: {
    gap: spacing.md,
    marginBottom: spacing.md,
  },

  // Picker section
  pickerSection: {
    gap: spacing.xs,
  },
  pickerLabel: {
    ...typography.titleSmall,
  },
  pickerValue: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: touchTarget.min,
  },
  pickerValueText: {
    ...typography.body,
    flex: 1,
  },
  pickerValueKm: {
    ...typography.caption,
    fontVariant: ['tabular-nums'],
    marginLeft: spacing.sm,
  },

  // Dropdown
  pickerDropdown: {
    marginTop: spacing.xs,
  },
  searchInput: {
    ...typography.body,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: touchTarget.min,
    marginBottom: spacing.sm,
  },
  kmEntryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.sm,
    gap: spacing.sm,
  },
  kmEntryLabel: {
    ...typography.caption,
  },
  kmEntryInput: {
    ...typography.body,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    minHeight: touchTarget.min,
    width: 100,
    fontVariant: ['tabular-nums'],
  },

  // Waypoint list
  waypointList: {
    maxHeight: 240,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: touchTarget.min,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderRadius: radii.md,
    marginBottom: spacing.xs,
  },
  emoji: {
    fontSize: 18,
    width: 28,
    textAlign: 'center',
  },
  rowContent: {
    flex: 1,
    marginLeft: spacing.sm,
  },
  rowName: {
    ...typography.body,
  },
  rowKm: {
    ...typography.caption,
    fontVariant: ['tabular-nums'],
    marginTop: 2,
  },
  check: {
    fontSize: 20,
    fontWeight: '700',
    marginLeft: spacing.sm,
  },

  // Select on map
  selectOnMapButton: {
    borderWidth: 1,
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: touchTarget.min,
    marginTop: spacing.sm,
  },
  selectOnMapText: {
    ...typography.body,
    fontWeight: '600',
  },

  // Summary
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.md,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  summaryLabel: {
    ...typography.body,
  },
  summaryValue: {
    ...typography.displaySmall,
    fontVariant: ['tabular-nums'],
  },

  // Error
  errorText: {
    ...typography.caption,
    marginBottom: spacing.md,
  },

  // Action buttons
  actions: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  button: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: touchTarget.min,
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
  },
  cancelButton: {
    borderWidth: 1,
  },
  applyButton: {},
  buttonText: {
    ...typography.body,
    fontWeight: '600',
  },
});
