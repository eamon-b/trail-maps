/**
 * The map's "layers" sheet: which OpenStreetMap points of interest to draw.
 *
 * A master switch plus one row per category, each with the number of markers it
 * controls, so "Camping · 13" means thirteen pins appear when it is on. The
 * counts come from `countPoisByCategory`, the same helper `visiblePois` agrees
 * with, which is what stops the sheet and the map from disagreeing.
 *
 * State is written straight to the settings store: the filter is global (not
 * per trail), persisted, and read by every POI surface through
 * `useVisiblePois`. Nothing is passed back to the caller.
 *
 * It is a plain bottom-anchored `Modal`, following ReportDialog rather than
 * reaching for a gesture-driven sheet library — a switch list does not need
 * drag-to-dismiss, and this keeps the app's one dialog pattern.
 *
 * The footer is not decoration: POIs are uncurated third-party data drawn
 * beside the trail's own checked waypoints, and the walker is told so wherever
 * they are shown, with the OSM credit line.
 */

import React from 'react';
import { Image, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import {
  countPoisByCategory,
  OSM_ATTRIBUTION,
  POI_CATEGORIES,
  POI_CATEGORY_LABELS,
} from '@lib/poi-display';
import type { TrailPOI, TrailPOICategory } from '@lib/trail-types';
import { useTheme } from '../../theme';
import { radii, spacing, touchTarget, typography } from '../../tokens';
import { selectPoiFilter, useSettingsStore } from '../../state/settings-store';
import { poiColor } from '../elevation/waypoint-category';
import { poiIconName } from './waypoint-icons';
import { WAYPOINT_ICON_IMAGES } from './waypoint-icon-images';

export interface PoiLayersSheetProps {
  visible: boolean;
  onClose: () => void;
  /**
   * The trail's full POI list — unfiltered, because the counts have to describe
   * what each switch would show, not what is showing now. Duplicates of curated
   * waypoints are excluded by `countPoisByCategory` itself.
   */
  pois: TrailPOI[];
}

export function PoiLayersSheet({ visible, onClose, pois }: PoiLayersSheetProps) {
  const { colors } = useTheme();
  const filter = useSettingsStore(selectPoiFilter);
  const setPoiEnabled = useSettingsStore((s) => s.setPoiEnabled);
  const setPoiCategory = useSettingsStore((s) => s.setPoiCategory);

  const counts = React.useMemo(() => countPoisByCategory(pois), [pois]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      {/* Tapping the scrim dismisses, like every other sheet on the platform. */}
      <Pressable
        style={[styles.backdrop, { backgroundColor: colors.scrim }]}
        accessibilityRole="button"
        accessibilityLabel="Close map layers"
        onPress={onClose}
      >
        {/* An inner Pressable with no handler swallows taps on the sheet itself
            so toggling a switch never also dismisses the sheet. */}
        <Pressable
          style={[styles.sheet, { backgroundColor: colors.surfaceElevated }]}
          accessibilityViewIsModal
        >
          <View style={styles.header}>
            <View style={styles.headings}>
              <Text style={[styles.title, { color: colors.textPrimary }]}>Points of interest</Text>
              <Text style={[styles.subtitle, { color: colors.textSecondary }]}>OpenStreetMap</Text>
            </View>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close map layers"
              style={({ pressed }) => [styles.done, pressed && styles.pressed]}
            >
              <Text style={[styles.doneText, { color: colors.accent }]}>Done</Text>
            </Pressable>
          </View>

          <ScrollView
            style={styles.list}
            contentContainerStyle={styles.listContent}
            bounces={false}
          >
            <View style={[styles.masterRow, { borderColor: colors.border }]}>
              <Text style={[styles.masterLabel, { color: colors.textPrimary }]}>
                Show points of interest
              </Text>
              <Switch
                value={filter.enabled}
                onValueChange={setPoiEnabled}
                accessibilityRole="switch"
                accessibilityLabel="Show points of interest"
                accessibilityState={{ checked: filter.enabled }}
                trackColor={{ true: colors.accentMuted, false: colors.border }}
                thumbColor={filter.enabled ? colors.accent : colors.surface}
              />
            </View>

            {POI_CATEGORIES.map((category) => (
              <CategoryRow
                key={category}
                category={category}
                count={counts[category]}
                // A category with nothing to show is inert rather than hidden:
                // "Emergency · 0" is the answer to "why do I see none?".
                enabled={filter.enabled}
                visible={filter.categories[category]}
                onChange={(next) => setPoiCategory(category, next)}
              />
            ))}

            <Text style={[styles.note, { color: colors.textSecondary }]}>
              Uncurated OpenStreetMap data, shown alongside the trail’s own waypoints so you can
              judge it.
            </Text>
            <Text style={[styles.attribution, { color: colors.textSecondary }]}>
              {OSM_ATTRIBUTION}
            </Text>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function CategoryRow({
  category,
  count,
  enabled,
  visible,
  onChange,
}: {
  category: TrailPOICategory;
  count: number;
  /** The master switch. Off greys every category row out. */
  enabled: boolean;
  visible: boolean;
  onChange: (next: boolean) => void;
}) {
  const { colors } = useTheme();
  const label = POI_CATEGORY_LABELS[category];
  const disabled = !enabled || count === 0;
  const tint = poiColor(category, colors);

  return (
    <View style={[styles.row, disabled && styles.rowDisabled]}>
      {/* The map's badge, shrunk: the same glyph inside a ring in the category
          colour, so a row is recognisable as the marker it controls. The glyph
          PNGs are dark ink, so they are tinted to the theme's text colour
          rather than left to vanish against a dark sheet. */}
      <View style={[styles.badge, { borderColor: tint, backgroundColor: colors.surface }]}>
        <Image
          source={WAYPOINT_ICON_IMAGES[poiIconName(category)]}
          style={[styles.glyph, { tintColor: colors.textPrimary }]}
          accessibilityIgnoresInvertColors
        />
      </View>
      <View style={styles.rowText}>
        <Text style={[styles.rowLabel, { color: colors.textPrimary }]}>{label}</Text>
        <Text style={[styles.rowCount, { color: colors.textSecondary }]}>
          {count === 1 ? '1 point' : `${count} points`}
        </Text>
      </View>
      <Switch
        value={visible && !disabled}
        onValueChange={onChange}
        disabled={disabled}
        accessibilityRole="switch"
        accessibilityLabel={`${label} points of interest`}
        accessibilityHint={count === 0 ? 'None on this trail' : undefined}
        accessibilityState={{ checked: visible && !disabled, disabled }}
        trackColor={{ true: colors.accentMuted, false: colors.border }}
        thumbColor={visible && !disabled ? colors.accent : colors.surface}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
    maxHeight: '85%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  headings: {
    flex: 1,
    gap: spacing.xs,
  },
  title: {
    ...typography.titleLarge,
  },
  subtitle: {
    ...typography.caption,
  },
  done: {
    minHeight: touchTarget.min,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },
  doneText: {
    ...typography.titleSmall,
  },
  list: {
    flexGrow: 0,
  },
  listContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    gap: spacing.xs,
  },
  masterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    minHeight: touchTarget.min,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  masterLabel: {
    ...typography.body,
    flex: 1,
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: touchTarget.min,
  },
  rowDisabled: {
    opacity: 0.4,
  },
  badge: {
    width: 28,
    height: 28,
    borderRadius: radii.full,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyph: {
    width: 16,
    height: 16,
    resizeMode: 'contain',
  },
  rowText: {
    flex: 1,
  },
  rowLabel: {
    ...typography.body,
  },
  rowCount: {
    ...typography.caption,
  },
  note: {
    ...typography.caption,
    marginTop: spacing.md,
  },
  attribution: {
    ...typography.caption,
  },
  pressed: {
    opacity: 0.6,
  },
});
