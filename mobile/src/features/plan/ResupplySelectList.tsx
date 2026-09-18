/**
 * The resupply picker's list: every option the trail offers, grouped by the
 * turn-off you leave the route at, each with a checkbox.
 *
 * Presentational — the modal route owns the selection and every handler. The
 * list is trail-wide even when the plan screen is showing one section, because
 * the choice is about the trail; rows outside the current section dim and say
 * so, which is what keeps the list and the legs card from appearing to
 * disagree about a ticked town that produces no leg.
 *
 * A checkbox rather than a Switch: this is a pick, not a setting. It is drawn
 * from theme tokens (no icon library) so it works on an offline map screen the
 * same as anywhere else.
 */

import React, { useCallback, useMemo } from 'react';
import { FlatList, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { formatDistance } from '@lib/format-distance';
import { accessSummary, firstSentence } from '@lib/resupply-display';
import type { ResupplyOption, ResupplyOptionGroup } from '@lib/resupply-plan';
import { useTheme } from '../../theme';
import { glyphSizes, radii, spacing, touchTarget, typography } from '../../tokens';
import type { Units } from '../../state/settings-store';
import { WAYPOINT_ICON_IMAGES } from '../map/waypoint-icon-images';
import { waypointIconName } from '../map/waypoint-icons';

/** The km window the plan screen is showing, when it passed one. */
export interface ResupplySection {
  startKm: number;
  endKm: number;
}

export interface ResupplySelectListProps {
  groups: ResupplyOptionGroup[];
  selectedIds: ReadonlySet<string>;
  /** Null (or absent) dims nothing — the picker was opened without a section. */
  section?: ResupplySection | null;
  units: Units;
  /** Whether a plan exists at all; `Reset` is meaningless without one. */
  planMade: boolean;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onReset: () => void;
}

/** One line of the flattened list: a group's turn-off, or an option to tick. */
type Row =
  | { kind: 'group'; key: string; label: string; km: number }
  | { kind: 'option'; key: string; option: ResupplyOption; inSection: boolean };

export function ResupplySelectList({
  groups,
  selectedIds,
  section,
  units,
  planMade,
  onToggle,
  onSelectAll,
  onSelectNone,
  onReset,
}: ResupplySelectListProps) {
  const { colors } = useTheme();

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const group of groups) {
      if (group.label) {
        out.push({ kind: 'group', key: `g-${group.key}`, label: group.label, km: group.km });
      }
      for (const option of group.options) {
        const inSection =
          !section || (option.km >= section.startKm && option.km <= section.endKm);
        out.push({ kind: 'option', key: option.id, option, inSection });
      }
    }
    return out;
  }, [groups, section]);

  const total = useMemo(
    () => groups.reduce((n, group) => n + group.options.length, 0),
    [groups],
  );
  // Counted against the trail's own options, so an id left over from an older
  // build is not reported as a stop the hiker can see.
  const chosen = useMemo(
    () =>
      groups.reduce(
        (n, group) => n + group.options.filter((o) => selectedIds.has(o.id)).length,
        0,
      ),
    [groups, selectedIds],
  );

  const renderItem = useCallback(
    ({ item }: { item: Row }) =>
      item.kind === 'group' ? (
        <GroupHeader label={item.label} km={item.km} units={units} />
      ) : (
        <OptionRow
          option={item.option}
          checked={selectedIds.has(item.option.id)}
          inSection={item.inSection}
          units={units}
          onToggle={onToggle}
        />
      ),
    [selectedIds, units, onToggle],
  );

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.headerRow}>
          <Text style={[styles.count, { color: colors.textPrimary }]}>
            {chosen} of {total} stops
          </Text>
          <View style={styles.chips}>
            <Chip label="All" onPress={onSelectAll} />
            <Chip label="None" onPress={onSelectNone} />
            <Chip label="Reset" onPress={onReset} disabled={!planMade} />
          </View>
        </View>
        <Text style={[styles.headerCaption, { color: colors.textSecondary }]}>
          Reset · clears the plan
        </Text>
      </View>

      <FlatList
        data={rows}
        keyExtractor={(row) => row.key}
        renderItem={renderItem}
        contentContainerStyle={styles.listContent}
      />
    </View>
  );
}

function Chip({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      hitSlop={spacing.sm}
      style={({ pressed }) => [pressed && styles.pressed, disabled && styles.disabled]}
    >
      <Text style={[styles.chipText, { color: colors.accent }]}>{label}</Text>
    </Pressable>
  );
}

function GroupHeader({ label, km, units }: { label: string; km: number; units: Units }) {
  const { colors } = useTheme();
  return (
    <Text style={[styles.groupHeader, { color: colors.textSecondary }]}>
      ⤴ {label} · {formatDistance(km, units)}
    </Text>
  );
}

/**
 * Memoised: the CDT lists 80 options, and ticking one must not re-render the
 * other 79. Every prop is stable per row as long as the route memoises its
 * handlers and the selection Set.
 */
const OptionRow = React.memo(function OptionRow({
  option,
  checked,
  inSection,
  units,
  onToggle,
}: {
  option: ResupplyOption;
  checked: boolean;
  inSection: boolean;
  units: Units;
  onToggle: (id: string) => void;
}) {
  const { colors } = useTheme();
  const subline = sublineFor(option, units);

  return (
    <Pressable
      onPress={() => onToggle(option.id)}
      accessibilityRole="checkbox"
      accessibilityLabel={option.name}
      accessibilityState={{ checked }}
      style={({ pressed }) => [
        styles.row,
        { borderColor: colors.border },
        !inSection && styles.rowOutside,
        pressed && styles.pressed,
      ]}
    >
      <View
        style={[
          styles.checkbox,
          checked
            ? { backgroundColor: colors.accent, borderColor: colors.accent }
            : { borderColor: colors.border },
        ]}
      >
        {checked && <Text style={[styles.tick, { color: colors.accentText }]}>✓</Text>}
      </View>
      {/* The glyph PNGs are dark ink, so they are tinted to the theme's text
          colour rather than left to vanish against a dark background. */}
      <Image
        source={WAYPOINT_ICON_IMAGES[waypointIconName(option.type)]}
        style={[styles.glyph, { tintColor: colors.textPrimary }]}
        accessibilityIgnoresInvertColors
      />
      <View style={styles.rowText}>
        <Text style={[styles.name, { color: colors.textPrimary }]} numberOfLines={1}>
          {option.name}
        </Text>
        {subline !== '' && (
          <Text style={[styles.subline, { color: colors.textSecondary }]} numberOfLines={2}>
            {subline}
          </Text>
        )}
      </View>
      <Text style={[styles.km, { color: colors.textSecondary }]}>
        {inSection ? formatDistance(option.km, units) : 'outside section'}
      </Text>
    </Pressable>
  );
});

/** "22.5 km hitch · Trail town with a post office · accepts boxes". */
function sublineFor(option: ResupplyOption, units: Units): string {
  return [
    accessSummary(option, (km) => formatDistance(km, units)),
    option.description ? firstSentence(option.description) : '',
    option.acceptsBoxes ? 'accepts boxes' : '',
  ]
    .filter((part) => part !== '')
    .join(' · ');
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  header: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  count: { ...typography.titleSmall, fontVariant: ['tabular-nums'] },
  chips: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  chipText: { ...typography.bodySmall, fontWeight: '700' },
  headerCaption: { ...typography.caption },

  listContent: { paddingBottom: spacing.xl },
  groupHeader: {
    ...typography.caption,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: touchTarget.min,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowOutside: { opacity: 0.45 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: radii.sm,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tick: { fontSize: glyphSizes.xs, fontWeight: '700', lineHeight: glyphSizes.md },
  glyph: { width: glyphSizes.sm, height: glyphSizes.sm, resizeMode: 'contain' },
  rowText: { flex: 1, gap: spacing.xs },
  name: { ...typography.titleSmall },
  subline: { ...typography.caption },
  km: { ...typography.bodySmall, fontVariant: ['tabular-nums'], textAlign: 'right' },

  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.35 },
});
