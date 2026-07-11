import { useCallback, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '../../src/theme';
import { useReduceMotion } from '../../src/theme/useReduceMotion';
import { springConfigs, timingConfigs } from '../../src/tokens/motion';
import { glyphSizes, typography } from '../../src/tokens/typography';
import { spacing, radii, touchTarget } from '../../src/tokens/spacing';
import { UndoToast } from '../../src/components/UndoToast';
import { waypointEmojis } from '../../src/components/WaypointList';
import {
  TrailDataService,
  type CustomWaypoint,
  type Trail,
} from '../../src/services/trail-data-service';
import { deleteCustomTrail } from '../../src/services/custom-trail-service';
import { deleteWaypointPhoto } from '../../src/services/waypoint-photo-service';
import {
  RouteService,
  resolveRoutePoints,
  type Route,
} from '../../src/services/route-service';
import { waypointsToGpx, routeToGpx } from '../../src/lib/gpx-writer';
import { shareGpxFile, gpxFilename } from '../../src/services/gpx-export-service';

type MyWaypoint = CustomWaypoint & { trailName: string };

/**
 * Swipe-left-to-delete wrapper for a My-waypoints row (same Pan-gesture
 * recipe as DayPlanCard's swipe-to-remove).
 */
function SwipeableRow({ children, onSwipeDelete }: { children: React.ReactNode; onSwipeDelete: () => void }) {
  const reduceMotion = useReduceMotion();
  const { width: screenWidth } = useWindowDimensions();
  const swipeThreshold = screenWidth * 0.4;
  const translateX = useSharedValue(0);

  const swipeGesture = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .failOffsetY([-5, 5])
    .onUpdate((event) => {
      if (event.translationX < 0) {
        translateX.value = event.translationX;
      }
    })
    .onEnd((event) => {
      if (event.translationX < -swipeThreshold) {
        if (reduceMotion) {
          translateX.value = -screenWidth;
          runOnJS(onSwipeDelete)();
        } else {
          translateX.value = withTiming(-screenWidth, timingConfigs.slideIn, (finished) => {
            if (finished) {
              runOnJS(onSwipeDelete)();
            }
          });
        }
      } else {
        translateX.value = reduceMotion ? 0 : withSpring(0, springConfigs.cardReorder);
      }
    });

  const swipeStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  return (
    <GestureDetector gesture={swipeGesture}>
      <Animated.View style={swipeStyle}>{children}</Animated.View>
    </GestureDetector>
  );
}

/**
 * The Contribute tab as the "My data" management home (P1 PR E, roadmap 11):
 * every piece of user-created data — waypoints across all trails, imported
 * trails, saved routes — listed, exportable, and manageable in one place.
 * Community sharing stays honestly labelled as v2.
 */
export default function MyDataScreen() {
  const { colors } = useTheme();
  const router = useRouter();

  const [waypoints, setWaypoints] = useState<MyWaypoint[]>([]);
  const [trails, setTrails] = useState<Trail[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [trailNamesById, setTrailNamesById] = useState<Record<string, string>>({});
  // Deleted waypoint held for the undo toast (photo deletion deferred)
  const [deletedWaypoint, setDeletedWaypoint] = useState<MyWaypoint | null>(null);
  // Inline rename state for custom trails
  const [renamingTrailId, setRenamingTrailId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const load = useCallback(async () => {
    try {
      const service = await TrailDataService.create();
      const [wps, customTrails, allTrails] = await Promise.all([
        service.getAllCustomWaypoints(),
        service.listCustomTrails(),
        service.listTrails(),
      ]);
      const routeService = await RouteService.create();
      const allRoutes = await routeService.listRoutes();

      setWaypoints(wps);
      setTrails(customTrails);
      setRoutes(allRoutes);
      setTrailNamesById(Object.fromEntries(allTrails.map(t => [t.id, t.name])));
    } catch (e) {
      console.warn('Failed to load My data:', e);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // --- My waypoints ---------------------------------------------------------

  const openWaypointOnMap = useCallback((wp: MyWaypoint) => {
    router.push({
      pathname: '/trail/[id]',
      params: { id: wp.trailId, focusWaypointId: `custom-${wp.id}` },
    });
  }, [router]);

  const handleDeleteWaypoint = useCallback(async (wp: MyWaypoint) => {
    try {
      const service = await TrailDataService.create();
      await service.deleteCustomWaypoint(wp.id);
      setDeletedWaypoint(wp);
      await load();
    } catch (e) {
      console.warn('Failed to delete waypoint:', e);
    }
  }, [load]);

  const handleUndoDeleteWaypoint = useCallback(async () => {
    const wp = deletedWaypoint;
    setDeletedWaypoint(null);
    if (!wp) return;
    try {
      const service = await TrailDataService.create();
      const { trailName: _ignored, ...row } = wp;
      await service.restoreCustomWaypoint(row);
      await load();
    } catch (e) {
      console.warn('Failed to restore waypoint:', e);
    }
  }, [deletedWaypoint, load]);

  const handleWaypointDeleteToastDismiss = useCallback(() => {
    if (deletedWaypoint?.photoUri) {
      deleteWaypointPhoto(deletedWaypoint.photoUri);
    }
    setDeletedWaypoint(null);
  }, [deletedWaypoint]);

  const handleExportAllWaypoints = useCallback(async () => {
    if (waypoints.length === 0) return;
    try {
      const gpx = waypointsToGpx(
        waypoints.map(wp => ({
          name: wp.name,
          lat: wp.lat,
          lon: wp.lon,
          ele: wp.ele,
          type: wp.type,
          description: wp.description,
          createdAt: wp.createdAt,
        })),
        { name: 'My waypoints' },
      );
      await shareGpxFile(gpxFilename('my-waypoints'), gpx);
    } catch (e) {
      console.warn('Failed to export waypoints:', e);
      Alert.alert('Export failed', 'Could not export the GPX file.');
    }
  }, [waypoints]);

  // --- My trails -------------------------------------------------------------

  const startRenameTrail = useCallback((trail: Trail) => {
    setRenamingTrailId(trail.id);
    setRenameValue(trail.name);
  }, []);

  const handleSaveRename = useCallback(async () => {
    const id = renamingTrailId;
    const name = renameValue.trim();
    setRenamingTrailId(null);
    if (!id || !name) return;
    try {
      const service = await TrailDataService.create();
      await service.updateCustomTrail(id, name);
      await load();
    } catch (e) {
      console.warn('Failed to rename trail:', e);
      Alert.alert('Rename failed', 'Could not rename the trail.');
    }
  }, [renamingTrailId, renameValue, load]);

  const handleDeleteTrail = useCallback((trail: Trail) => {
    // Trail deletion cascades to its plans, waypoints, and routes — an undo
    // toast can't cheaply restore all of that, so this keeps the confirm.
    Alert.alert(
      'Delete Custom Trail',
      `Delete "${trail.name}" and all associated data (plans, waypoints, routes)? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteCustomTrail(trail.id);
              await load();
            } catch (e) {
              console.warn('Failed to delete trail:', e);
            }
          },
        },
      ],
    );
  }, [load]);

  // --- My routes --------------------------------------------------------------

  const openRouteOnMap = useCallback((route: Route) => {
    router.push({
      pathname: '/trail/[id]',
      params: { id: route.trailId, routeId: route.id },
    });
  }, [router]);

  const handleShareRoute = useCallback(async (route: Route) => {
    try {
      const trailService = await TrailDataService.create();
      const trail = await trailService.getMergedTrail(route.trailId);
      if (!trail) throw new Error('Trail data unavailable');
      const routeService = await RouteService.create();
      const legs = await routeService.getRouteLegs(route.id);
      const points = resolveRoutePoints(trail, legs);
      const gpx = routeToGpx(route.name, points.map(pt => ({
        lat: pt.lat, lon: pt.lon, ele: pt.ele, name: pt.name,
      })));
      await shareGpxFile(gpxFilename(route.name), gpx);
    } catch (e) {
      console.warn('Failed to share route:', e);
      Alert.alert('Export failed', 'Could not export the GPX file.');
    }
  }, []);

  const handleDeleteRoute = useCallback((route: Route) => {
    Alert.alert('Delete route', `Delete "${route.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            const service = await RouteService.create();
            await service.deleteRoute(route.id);
            await load();
          } catch (e) {
            console.warn('Failed to delete route:', e);
          }
        },
      },
    ]);
  }, [load]);

  // --- Render ------------------------------------------------------------------

  // Group waypoints by trail (query is already ordered by trail name, km)
  const waypointGroups: { trailId: string; trailName: string; items: MyWaypoint[] }[] = [];
  for (const wp of waypoints) {
    const last = waypointGroups[waypointGroups.length - 1];
    if (last && last.trailId === wp.trailId) {
      last.items.push(wp);
    } else {
      waypointGroups.push({ trailId: wp.trailId, trailName: wp.trailName, items: [wp] });
    }
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={[styles.title, { color: colors.accent }]}>My data</Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
          Everything you have added — waypoints, imported trails, and routes. All stored on this
          phone; export any of it as GPX.
        </Text>

        {/* ------------------------------------------------ My waypoints --- */}
        <View style={styles.sectionHeaderRow}>
          <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
            MY WAYPOINTS{waypoints.length > 0 ? ` (${waypoints.length})` : ''}
          </Text>
          {waypoints.length > 0 && (
            <Pressable
              onPress={handleExportAllWaypoints}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Export all waypoints as GPX"
            >
              <Text style={[styles.sectionAction, { color: colors.accent }]}>Export all (GPX)</Text>
            </Pressable>
          )}
        </View>

        {waypoints.length === 0 ? (
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            No waypoints yet. Mark your location from the Hike screen, or use the + button (or a
            long-press) on any trail map.
          </Text>
        ) : (
          waypointGroups.map(group => (
            <View key={group.trailId} style={styles.group}>
              <Text style={[styles.groupTitle, { color: colors.textPrimary }]}>{group.trailName}</Text>
              {group.items.map(wp => (
                <SwipeableRow key={wp.id} onSwipeDelete={() => handleDeleteWaypoint(wp)}>
                  <Pressable
                    onPress={() => openWaypointOnMap(wp)}
                    style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}
                    accessibilityRole="button"
                    accessibilityLabel={`${wp.name}, ${group.trailName}, kilometre ${wp.kmPosition.toFixed(1)}. Tap to show on the map; swipe left to delete.`}
                  >
                    <Text style={styles.rowEmoji}>{waypointEmojis[wp.type] ?? waypointEmojis.poi}</Text>
                    <View style={styles.rowInfo}>
                      <Text style={[styles.rowName, { color: colors.textPrimary }]} numberOfLines={1}>
                        {wp.name}
                      </Text>
                      <Text style={[styles.rowDetail, { color: colors.textSecondary }]} numberOfLines={1}>
                        km {wp.kmPosition.toFixed(1)}
                        {wp.photoUri ? ' · 📷' : ''}
                        {wp.description ? ` · ${wp.description.split('\n')[0]}` : ''}
                      </Text>
                    </View>
                    <Text style={[styles.rowChevron, { color: colors.textSecondary }]}>›</Text>
                  </Pressable>
                </SwipeableRow>
              ))}
            </View>
          ))
        )}

        {/* ------------------------------------------------ My trails ------ */}
        <View style={styles.sectionHeaderRow}>
          <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
            MY TRAILS{trails.length > 0 ? ` (${trails.length})` : ''}
          </Text>
        </View>

        {trails.length === 0 && (
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            No imported trails yet.
          </Text>
        )}
        {trails.map(trail => (
          <View
            key={trail.id}
            style={[styles.row, styles.trailRow, { backgroundColor: colors.surface, borderColor: colors.border }]}
          >
            {renamingTrailId === trail.id ? (
              <View style={styles.renameRow}>
                <TextInput
                  value={renameValue}
                  onChangeText={setRenameValue}
                  autoFocus
                  onSubmitEditing={handleSaveRename}
                  returnKeyType="done"
                  accessibilityLabel="Trail name"
                  style={[styles.renameInput, { color: colors.textPrimary, borderColor: colors.border }]}
                />
                <Pressable onPress={handleSaveRename} style={styles.rowAction} accessibilityRole="button" accessibilityLabel="Save trail name">
                  <Text style={[styles.rowActionText, { color: colors.accent }]}>Save</Text>
                </Pressable>
                <Pressable onPress={() => setRenamingTrailId(null)} style={styles.rowAction} accessibilityRole="button" accessibilityLabel="Cancel rename">
                  <Text style={[styles.rowActionText, { color: colors.textSecondary }]}>Cancel</Text>
                </Pressable>
              </View>
            ) : (
              <>
                <Pressable
                  style={styles.rowInfo}
                  onPress={() => router.push(`/trail/overview?id=${trail.id}`)}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${trail.name}`}
                >
                  <Text style={[styles.rowName, { color: colors.textPrimary }]} numberOfLines={1}>
                    {trail.name}
                  </Text>
                  <Text style={[styles.rowDetail, { color: colors.textSecondary }]} numberOfLines={1}>
                    {trail.lengthKm != null ? `${Math.round(trail.lengthKm)} km · ` : ''}
                    {trail.sourceFilename ? `${trail.sourceFilename} · ` : ''}
                    added {new Date(trail.createdAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </Text>
                </Pressable>
                <Pressable onPress={() => startRenameTrail(trail)} style={styles.rowAction} accessibilityRole="button" accessibilityLabel={`Rename ${trail.name}`}>
                  <Text style={[styles.rowActionText, { color: colors.accent }]}>Rename</Text>
                </Pressable>
                <Pressable onPress={() => handleDeleteTrail(trail)} style={styles.rowAction} accessibilityRole="button" accessibilityLabel={`Delete ${trail.name}`}>
                  <Text style={[styles.rowActionText, { color: colors.alertRed }]}>Delete</Text>
                </Pressable>
              </>
            )}
          </View>
        ))}

        <Pressable
          onPress={() => router.push('/import')}
          style={[styles.importButton, { backgroundColor: colors.accent }]}
          accessibilityRole="button"
          accessibilityLabel="Import a GPX trail"
        >
          <Text style={[styles.importButtonText, { color: colors.textInverse }]}>Import GPX Trail</Text>
        </Pressable>

        {/* ------------------------------------------------ My routes ------ */}
        <View style={styles.sectionHeaderRow}>
          <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
            MY ROUTES{routes.length > 0 ? ` (${routes.length})` : ''}
          </Text>
        </View>

        {routes.length === 0 && (
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            No routes yet. Open a trail map and tap the route button to string waypoints into a
            named route.
          </Text>
        )}
        {routes.map(route => (
          <View
            key={route.id}
            style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}
          >
            <Pressable
              style={styles.rowInfo}
              onPress={() => openRouteOnMap(route)}
              accessibilityRole="button"
              accessibilityLabel={`Show route ${route.name} on the map`}
            >
              <Text style={[styles.rowName, { color: colors.textPrimary }]} numberOfLines={1}>
                {route.name}
              </Text>
              <Text style={[styles.rowDetail, { color: colors.textSecondary }]} numberOfLines={1}>
                {trailNamesById[route.trailId] ?? route.trailId}
              </Text>
            </Pressable>
            <Pressable onPress={() => handleShareRoute(route)} style={styles.rowAction} accessibilityRole="button" accessibilityLabel={`Share route ${route.name} as GPX`}>
              <Text style={[styles.rowActionText, { color: colors.accent }]}>Share</Text>
            </Pressable>
            <Pressable onPress={() => handleDeleteRoute(route)} style={styles.rowAction} accessibilityRole="button" accessibilityLabel={`Delete route ${route.name}`}>
              <Text style={[styles.rowActionText, { color: colors.alertRed }]}>Delete</Text>
            </Pressable>
          </View>
        ))}

        {/* ------------------------------------------- Community (v2) ------ */}
        <View style={[styles.footer, { borderTopColor: colors.border }]}>
          <Text style={[styles.footerText, { color: colors.textSecondary }]}>
            Sharing with the community — water source status reports, waypoint submissions — is
            coming in v2. Until then everything above stays on your phone, and GPX export means
            none of it is ever trapped here.
          </Text>
        </View>
      </ScrollView>

      {/* Undo toast for a swiped-away waypoint (5 s window) */}
      <UndoToast
        visible={deletedWaypoint != null}
        message={deletedWaypoint ? `Deleted "${deletedWaypoint.name}"` : ''}
        onUndo={handleUndoDeleteWaypoint}
        onDismiss={handleWaypointDeleteToastDismiss}
        durationMs={5000}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scroll: {
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  title: {
    ...typography.displayLarge,
    marginBottom: spacing.xs,
  },
  subtitle: {
    ...typography.caption,
    lineHeight: 18,
    marginBottom: spacing.lg,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  sectionTitle: {
    ...typography.titleSmall,
  },
  sectionAction: {
    ...typography.caption,
    fontWeight: '600',
  },
  emptyText: {
    ...typography.caption,
    lineHeight: 18,
    marginBottom: spacing.sm,
  },
  group: {
    marginBottom: spacing.sm,
  },
  groupTitle: {
    ...typography.caption,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: touchTarget.min,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.xs,
    gap: spacing.sm,
  },
  trailRow: {
    minHeight: touchTarget.min + 8,
  },
  rowEmoji: {
    fontSize: glyphSizes.sm,
    width: 26,
    textAlign: 'center',
  },
  rowInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  rowName: {
    ...typography.body,
    fontWeight: '500',
  },
  rowDetail: {
    ...typography.caption,
    marginTop: 1,
  },
  rowChevron: {
    fontSize: glyphSizes.md,
  },
  rowAction: {
    minHeight: touchTarget.min,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },
  rowActionText: {
    ...typography.caption,
    fontWeight: '600',
  },
  renameRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  renameInput: {
    ...typography.body,
    flex: 1,
    borderBottomWidth: 1,
    paddingVertical: spacing.xs,
  },
  importButton: {
    minHeight: touchTarget.min,
    borderRadius: radii.lg,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.sm,
  },
  importButtonText: {
    ...typography.body,
    fontWeight: '700',
  },
  footer: {
    marginTop: spacing.xl,
    paddingTop: spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  footerText: {
    ...typography.caption,
    textAlign: 'center',
    lineHeight: 18,
  },
});
