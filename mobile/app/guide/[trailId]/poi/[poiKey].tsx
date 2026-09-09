/**
 * Point-of-interest detail screen.
 *
 * The read-only twin of the waypoint screen. A POI is uncurated OpenStreetMap
 * data — a lead the walker checks, not content the trail data stands behind —
 * so everything that implies the app vouches for the place, or that would file
 * user content against it, is deliberately absent: no favorite heart, no
 * comments feed, no composer, no water status, no check-in share. That also
 * means this screen issues no SQLite read and no network request; it renders
 * entirely from the trail JSON already in memory.
 *
 * The POI is resolved from `useGuide().trail.pois` — the direction-applied
 * trail, so `distanceAlongTrail` is already mirrored for a reversed guide — by
 * the slash-free `type-id` route key (a `/` in an Expo Router param is a path
 * separator). The key is user-reachable via a deep link, so `findPoiByRouteKey`
 * validates it rather than trusting it, and an unknown key lands on the
 * not-found state.
 *
 * Every string in a POI is untrusted. React Native text is not an injection
 * surface, but `Linking.openURL` is: the ONLY hrefs opened here are the ones
 * `summarisePoiTags` returns, because that is where the `http(s):`/`tel:`
 * scheme check lives. An OSM `website` tag holding `javascript:` comes back
 * with no href and renders as plain text.
 */

import React, { useMemo } from 'react';
import {
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { formatDistance } from '@lib/format-distance';
import {
  OSM_ATTRIBUTION,
  findPoiByRouteKey,
  poiCategoryLabel,
  poiDisplayName,
  poiOsmUrl,
  summarisePoiTags,
  type PoiTagLine,
} from '@lib/poi-display';
import { useTheme } from '../../../../src/theme';
import { radii, spacing, touchTarget, typography } from '../../../../src/tokens';
import { useSettingsStore } from '../../../../src/state/settings-store';
import { useGuide } from '../../../../src/features/guide/GuideContext';
import { useGuidePositionContext } from '../../../../src/features/guide/GuidePositionContext';
import { poiColor } from '../../../../src/features/elevation/waypoint-category';
import { poiIconName } from '../../../../src/features/map/waypoint-icons';
import { WAYPOINT_ICON_IMAGES } from '../../../../src/features/map/waypoint-icon-images';
import { formatSignedDistance } from '../../../../src/features/guide/waypoint-filters';
import { estimateEtaMinutes, formatEta } from '../../../../src/features/guide/waypoint-detail';
import { mapsUrlFor } from '../../../../src/features/guide/poi-detail';

export default function PoiDetailScreen() {
  const { poiKey } = useLocalSearchParams<{ trailId: string; poiKey: string }>();
  const { colors } = useTheme();
  const { trail } = useGuide();
  const units = useSettingsStore((s) => s.units);
  const { currentKm } = useGuidePositionContext();

  const poi = useMemo(
    () => findPoiByRouteKey(trail.pois, poiKey ?? ''),
    [trail.pois, poiKey],
  );

  const lines = useMemo(() => summarisePoiTags(poi?.tags), [poi]);

  if (!poi) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: 'Point of interest' }} />
        <Text style={[styles.notFoundTitle, { color: colors.textPrimary }]}>
          Point of interest not found
        </Text>
      </View>
    );
  }

  const name = poiDisplayName(poi);
  const category = poiCategoryLabel(poi.category);
  const badge = poiColor(poi.category, colors);
  const osmUrl = poiOsmUrl(poi);

  const deltaKm = currentKm != null ? poi.distanceAlongTrail - currentKm : null;
  const signed = deltaKm != null ? formatSignedDistance(deltaKm, units) : null;
  const etaLabel = deltaKm != null && deltaKm > 0 ? formatEta(estimateEtaMinutes(deltaKm)) : null;

  const openOsm = () => {
    void Linking.openURL(osmUrl);
  };

  // A device with no maps app is unusual but real (and `geo:`/`maps:` are not
  // universally handled), so fall back to the OSM map view rather than failing
  // silently.
  const openMaps = () => {
    const url = mapsUrlFor(poi.lat, poi.lon, name, Platform.OS);
    void (async () => {
      try {
        if (await Linking.canOpenURL(url)) {
          await Linking.openURL(url);
          return;
        }
      } catch {
        // Fall through to the web map.
      }
      await Linking.openURL(osmUrl);
    })();
  };

  return (
    <ScrollView
      style={[styles.flex, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.content}
      testID="poi-detail-scroll"
    >
      <Stack.Screen options={{ title: name }} />

      {/* Header: category glyph, name, and the badge that keeps a POI from
          ever being mistaken for a curated waypoint. */}
      <View style={styles.hero}>
        <View style={[styles.badge, { backgroundColor: badge }]}>
          <Image
            source={WAYPOINT_ICON_IMAGES[poiIconName(poi.category)]}
            style={[styles.glyph, { tintColor: colors.textInverse }]}
            resizeMode="contain"
            accessible={false}
            accessibilityIgnoresInvertColors
          />
        </View>
        <View style={styles.heroText}>
          <Text style={[styles.name, { color: colors.textPrimary }]}>{name}</Text>
          <View style={[styles.pill, { borderColor: colors.border }]}>
            <Text style={[styles.pillText, { color: colors.textSecondary }]}>OpenStreetMap</Text>
          </View>
        </View>
      </View>

      <Text style={[styles.meta, { color: colors.textSecondary }]}>
        {`${category} · ${formatDistance(poi.distanceAlongTrail, units)} along the trail · ${formatDistance(
          poi.distanceFromTrail,
          units,
          { decimals: 2 },
        )} off trail`}
      </Text>

      {signed && signed.direction !== 'here' && (
        <View style={styles.stats}>
          <Stat
            label={signed.direction === 'ahead' ? 'Ahead' : 'Behind'}
            value={
              etaLabel
                ? `${signed.label.replace(/ (ahead|behind)$/, '')} · ${etaLabel}`
                : signed.label
            }
          />
        </View>
      )}

      {lines.length > 0 && (
        <>
          <View style={[styles.divider, { backgroundColor: colors.border }]} />
          <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>Details</Text>
          <View style={styles.detailList}>
            {lines.map((line, i) => (
              <TagRow key={`${line.label}-${i}`} line={line} />
            ))}
          </View>
        </>
      )}

      <View style={[styles.divider, { backgroundColor: colors.border }]} />

      <View style={styles.actions}>
        <ActionButton label="Open in OpenStreetMap" onPress={openOsm} />
        <ActionButton label="Open in Maps" onPress={openMaps} />
      </View>

      <Text style={[styles.note, { color: colors.textSecondary }]}>
        Uncurated OpenStreetMap data. The trail’s own waypoints are the checked ones.
      </Text>
      <Text style={[styles.attribution, { color: colors.textSecondary }]}>{OSM_ATTRIBUTION}</Text>
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Rows and controls
// ---------------------------------------------------------------------------

/**
 * One summarised tag. Tappable only when the shared summariser produced an
 * `href` — this component never builds a URL of its own.
 */
function TagRow({ line }: { line: PoiTagLine }) {
  const { colors } = useTheme();
  const label = (
    <Text style={[styles.tagLabel, { color: colors.textSecondary }]}>{line.label}</Text>
  );

  if (!line.href) {
    return (
      <View style={styles.tagRow}>
        {label}
        <Text style={[styles.tagValue, { color: colors.textPrimary }]}>{line.value}</Text>
      </View>
    );
  }

  const href = line.href;
  return (
    <Pressable
      onPress={() => void Linking.openURL(href)}
      accessibilityRole="link"
      accessibilityLabel={`${line.label}: ${line.value}`}
      hitSlop={spacing.xs}
      style={({ pressed }) => [styles.tagRow, pressed && styles.pressed]}
    >
      {label}
      <Text style={[styles.tagValue, { color: colors.accent }]}>{line.value}</Text>
    </Pressable>
  );
}

function ActionButton({ label, onPress }: { label: string; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.action,
        { borderColor: colors.border, backgroundColor: colors.surface },
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.actionText, { color: colors.accent }]}>{label}</Text>
    </Pressable>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.stat, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.statLabel, { color: colors.textSecondary }]}>{label}</Text>
      <Text style={[styles.statValue, { color: colors.textPrimary }]}>{value}</Text>
    </View>
  );
}

const GLYPH = 22;
const BADGE = 40;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  notFoundTitle: { ...typography.displaySmall },

  hero: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  badge: {
    width: BADGE,
    height: BADGE,
    borderRadius: radii.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyph: { width: GLYPH, height: GLYPH },
  heroText: { flex: 1, gap: spacing.xs, alignItems: 'flex-start' },
  name: { ...typography.displaySmall },
  pill: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  pillText: { ...typography.caption },
  meta: { ...typography.bodySmall },

  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  stat: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    minWidth: 90,
  },
  statLabel: { ...typography.caption },
  statValue: { ...typography.titleSmall, fontVariant: ['tabular-nums'] },

  divider: { height: StyleSheet.hairlineWidth },
  sectionTitle: { ...typography.titleLarge },
  detailList: { gap: spacing.sm },
  tagRow: { gap: spacing.xs },
  tagLabel: { ...typography.caption },
  tagValue: { ...typography.body },

  actions: { gap: spacing.sm },
  action: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minHeight: touchTarget.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionText: { ...typography.titleSmall },
  pressed: { opacity: 0.6 },

  note: { ...typography.bodySmall },
  attribution: { ...typography.caption },
});
