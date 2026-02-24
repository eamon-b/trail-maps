import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  TextInput,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../src/theme';
import { PlanService, type Plan, type PlanVersion } from '../../src/services/plan-service';
import { TrailDataService } from '../../src/services/trail-data-service';
import {
  trailJsonToTrail,
  createReversedTrail,
  type Trail,
  type TrailWaypoint,
} from '../../src/lib/trail-utils';
import { computeDays, addStop, removeStop } from '../../src/services/day-calculator';
import type { StopData, SectionConfig, ComputedDay } from '../../src/services/plan-calculator-types';
import { DayPlanCard, type DayPlanData } from '../../src/components/DayPlanCard';
import { PlanSummaryCard } from '../../src/components/PlanSummaryCard';
import { StopSelector } from '../../src/components/StopSelector';
import { SectionSelector } from '../../src/components/SectionSelector';
import { ClimateOverview } from '../../src/components/ClimateOverview';
import { AppBottomSheet } from '../../src/components/AppBottomSheet';
import { UndoToast } from '../../src/components/UndoToast';
import { WaterCarryList } from '../../src/components/WaterCarryList';
import { ResupplyList } from '../../src/components/ResupplyList';
import { analyzeWaterCarry, analyzeWaterCarryForSection } from '../../src/services/water-carry-calculator';
import { analyzeResupply, analyzeResupplyForSection } from '../../src/services/resupply-calculator';
import { loadClimateData, getClimateForDay, type ClimateData, type DayClimate } from '../../src/services/climate-service';
import { exportPlanAsText, exportPlanAsCsv } from '../../src/services/plan-export';
import { generateId, migrateStopsJson } from '../../src/services/plan-utils';
import { spacing, radii, touchTarget } from '../../src/tokens/spacing';
import { typography } from '../../src/tokens/typography';

type DashboardTab = 'overview' | 'days' | 'climate';

function dayToCardData(day: ComputedDay): DayPlanData {
  return {
    dayNumber: day.dayNumber,
    date: day.date,
    startName: day.startName,
    endName: day.endName,
    distanceKm: day.distanceKm,
    ascentM: day.ascentM,
    descentM: day.descentM,
    estimatedHours: day.estimatedHours,
    waterSources: day.waterSources,
  };
}

export default function PlanEditorScreen() {
  const { planId, trailId: paramTrailId } = useLocalSearchParams<{ planId: string; trailId?: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const [plan, setPlan] = useState<Plan | null>(null);
  const [trail, setTrail] = useState<Trail | null>(null);
  const [stops, setStops] = useState<StopData[]>([]);
  const [section, setSection] = useState<SectionConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectorOpen, setSelectorOpen] = useState(false);

  // Save error state
  const [saveError, setSaveError] = useState(false);

  // PlanService reuse
  const planServiceRef = useRef<PlanService | null>(null);

  // Undo state
  const [undoVisible, setUndoVisible] = useState(false);
  const [undoMessage, setUndoMessage] = useState('');
  const undoStopsRef = useRef<StopData[] | null>(null);

  // Split state
  const [splitDay, setSplitDay] = useState<ComputedDay | null>(null);

  // Dashboard tabs
  const [activeTab, setActiveTab] = useState<DashboardTab>('days');

  // Section selector
  const [sectionSelectorOpen, setSectionSelectorOpen] = useState(false);

  // Climate data
  const [climateData, setClimateData] = useState<ClimateData | null>(null);


  // Versioning
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versions, setVersions] = useState<PlanVersion[]>([]);
  const [versionNameModalOpen, setVersionNameModalOpen] = useState(false);
  const [versionNameInput, setVersionNameInput] = useState('');

  // Load plan + trail data
  useEffect(() => {
    async function load() {
      if (!planId) return;
      try {
        const planService = await PlanService.create();
        planServiceRef.current = planService;
        const loaded = await planService.getPlan(planId);
        if (!loaded) {
          Alert.alert('Error', 'Plan not found');
          router.back();
          return;
        }
        setPlan(loaded);

        const tId = loaded.trailId || paramTrailId;
        if (!tId) {
          Alert.alert('Error', 'No trail associated with this plan');
          router.back();
          return;
        }

        const trailService = await TrailDataService.create();
        const json = await trailService.getTrailTrackData(tId);
        if (!json) {
          Alert.alert('Error', 'Trail data not found');
          router.back();
          return;
        }

        let parsed = trailJsonToTrail(json);
        if (loaded.direction === 'SOBO') {
          parsed = createReversedTrail(parsed);
        }
        setTrail(parsed);

        // Parse stops with migration for legacy format
        const parsedStops = migrateStopsJson(loaded.stopsJson);
        setStops(parsedStops);

        // Parse section config
        if (loaded.sectionJson) {
          try {
            setSection(JSON.parse(loaded.sectionJson));
          } catch { /* ignore invalid json */ }
        }

        setLoading(false);
      } catch (e) {
        Alert.alert('Error', e instanceof Error ? e.message : 'Failed to load plan');
        setLoading(false);
      }
    }
    load();
  }, [planId, paramTrailId, router]);

  // Load climate data when trail is available
  useEffect(() => {
    if (!plan?.trailId) return;
    const climate = loadClimateData(plan.trailId);
    setClimateData(climate);
  }, [plan?.trailId]);

  // Reload stops and section from DB when screen regains focus (e.g. after map changes)
  useFocusEffect(
    useCallback(() => {
      if (!planId || !planServiceRef.current) return;
      planServiceRef.current.getPlan(planId).then((loaded) => {
        if (loaded) {
          const parsedStops = migrateStopsJson(loaded.stopsJson);
          setStops(parsedStops);
          if (loaded.sectionJson) {
            try { setSection(JSON.parse(loaded.sectionJson)); } catch { /* ignore */ }
          } else {
            setSection(null);
          }
        }
      }).catch(() => {});
    }, [planId]),
  );

  // Persist stops to database
  const persistStops = useCallback(async (newStops: StopData[]) => {
    if (!planId) return;
    try {
      const service = planServiceRef.current ?? await PlanService.create();
      await service.updatePlan(planId, { stopsJson: JSON.stringify(newStops) });
      setSaveError(false);
    } catch (e) {
      console.warn('Failed to persist plan stops:', e);
      setSaveError(true);
    }
  }, [planId]);

  // Update stops and persist
  const updateStops = useCallback((newStops: StopData[]) => {
    setStops(newStops);
    persistStops(newStops);
  }, [persistStops]);

  // Compute days
  const days = useMemo(() => {
    if (!trail) return [];
    return computeDays(trail, stops, plan?.startDate, section);
  }, [trail, stops, plan?.startDate, section]);

  // Water carry and resupply analysis
  const waterAnalysis = useMemo(() => {
    if (!trail) return null;
    if (section) {
      return analyzeWaterCarryForSection(trail.waypoints, section.startKm, section.endKm);
    }
    return analyzeWaterCarry(trail.waypoints, trail.track.totalDistance);
  }, [trail, section]);

  const resupplyAnalysis = useMemo(() => {
    if (!trail) return null;
    if (section) {
      return analyzeResupplyForSection(trail.waypoints, section.startKm, section.endKm);
    }
    return analyzeResupply(trail.waypoints, trail.track.totalDistance);
  }, [trail, section]);

  // Selected stop kms for the selector
  const selectedStopKms = useMemo(() => {
    return new Set(stops.map(s => s.km));
  }, [stops]);

  // Eligible waypoints for stops (campsite, hut, town, shelter, food)
  const eligibleWaypoints = useMemo(() => {
    if (!trail) return [];
    const eligible = new Set(['campsite', 'hut', 'town', 'shelter', 'food']);
    return trail.waypoints.filter(wp => eligible.has(wp.type));
  }, [trail]);

  // Handle toggling a stop from the selector
  const handleToggleStop = useCallback((wp: TrailWaypoint) => {
    if (!trail) return;
    const km = wp.totalDistance ?? 0;

    const existingIdx = stops.findIndex(s => s.km === km);
    if (existingIdx >= 0) {
      const newStops = removeStop(stops, existingIdx);
      updateStops(newStops);
    } else {
      const newStop: StopData = {
        id: generateId(),
        waypointName: wp.name,
        waypointType: wp.type,
        km,
      };
      const newStops = addStop(stops, newStop);
      updateStops(newStops);
    }
  }, [trail, stops, updateStops]);

  // Handle remove (swipe-to-delete on a day card)
  const handleRemove = useCallback((dayIndex: number) => {
    // The stop to remove is the one that ENDS this day (i.e., stops[dayIndex])
    // Day 0 ends at stops[0], Day 1 ends at stops[1], etc.
    // Last day has no stop to remove.
    if (dayIndex >= stops.length) return;

    undoStopsRef.current = stops;
    const stop = stops[dayIndex];
    const removedName = stop.customLocation?.name ?? stop.waypointName ?? 'Stop';
    const newStops = removeStop(stops, dayIndex);
    updateStops(newStops);
    setUndoMessage(`Removed ${removedName}`);
    setUndoVisible(true);
  }, [stops, updateStops]);

  // Handle undo
  const handleUndo = useCallback(() => {
    if (undoStopsRef.current) {
      updateStops(undoStopsRef.current);
      undoStopsRef.current = null;
    }
    setUndoVisible(false);
  }, [updateStops]);

  const handleUndoDismiss = useCallback(() => {
    undoStopsRef.current = null;
    setUndoVisible(false);
  }, []);

  // Handle merge up (removes the stop between this day and previous)
  const handleMergeUp = useCallback((dayIndex: number) => {
    // Day N merges with Day N-1 by removing stops[dayIndex - 1]
    if (dayIndex < 1 || dayIndex - 1 >= stops.length) return;
    const stop = stops[dayIndex - 1];
    const removedName = stop.customLocation?.name ?? stop.waypointName ?? 'Stop';
    undoStopsRef.current = stops;
    const newStops = removeStop(stops, dayIndex - 1);
    updateStops(newStops);
    setUndoMessage(`Merged at ${removedName}`);
    setUndoVisible(true);
  }, [stops, updateStops]);

  // Handle split — show selector for waypoints between day's start/end
  const handleSplit = useCallback((dayIndex: number) => {
    if (!trail || dayIndex >= days.length) return;
    setSplitDay(days[dayIndex]);
  }, [trail, days]);

  // Eligible split waypoints for the selected day
  const splitWaypoints = useMemo(() => {
    if (!splitDay || !trail) return [];
    const eligible = new Set(['campsite', 'hut', 'town', 'shelter', 'food']);
    return trail.waypoints.filter(wp => {
      const km = wp.totalDistance ?? 0;
      return (
        eligible.has(wp.type) &&
        km > splitDay.startKm &&
        km < splitDay.endKm &&
        !selectedStopKms.has(km)
      );
    });
  }, [splitDay, trail, selectedStopKms]);

  const handleSplitSelect = useCallback((wp: TrailWaypoint) => {
    if (!trail) return;

    const newStop: StopData = {
      id: generateId(),
      waypointName: wp.name,
      waypointType: wp.type,
      km: wp.totalDistance ?? 0,
    };
    updateStops(addStop(stops, newStop));
    setSplitDay(null);
  }, [trail, stops, updateStops]);

  // Per-day climate
  const dayClimate = useMemo((): (DayClimate | null)[] => {
    if (!climateData) return days.map(() => null);
    return days.map(d => getClimateForDay(climateData, d));
  }, [climateData, days]);

  // Plan months for climate overview highlighting
  const planMonths = useMemo(() => {
    const months = new Set<number>();
    for (const d of days) {
      if (d.date) {
        const date = new Date(d.date + 'T12:00:00Z');
        if (!isNaN(date.getTime())) months.add(date.getUTCMonth() + 1);
      }
    }
    return Array.from(months);
  }, [days]);

  // Section selector handler
  const handleApplySection = useCallback(async (newSection: SectionConfig | null) => {
    setSection(newSection);
    setSectionSelectorOpen(false);
    if (!planId) return;
    try {
      const service = planServiceRef.current ?? await PlanService.create();
      await service.updatePlan(planId, { sectionJson: newSection ? JSON.stringify(newSection) : null });
    } catch (e) {
      console.warn('Failed to persist section:', e);
    }
  }, [planId]);

  // Select section on map handler
  const handleSelectSectionOnMap = useCallback(() => {
    if (!plan) return;
    setSectionSelectorOpen(false);
    router.push({
      pathname: '/plan/section-map',
      params: {
        trailId: plan.trailId,
        planId: plan.id,
        direction: plan.direction,
        mode: 'section',
        ...(section ? {
          currentStartKm: String(section.startKm),
          currentEndKm: String(section.endKm),
        } : {}),
      },
    });
  }, [plan, section, router]);

  // Show on map handler — navigate to map with the day's segment highlighted
  const handleShowOnMap = useCallback((dayIndex: number) => {
    if (!plan || dayIndex >= days.length) return;
    const day = days[dayIndex];
    router.push({
      pathname: '/plan/map',
      params: {
        trailId: plan.trailId,
        planId: plan.id,
        highlightStartKm: String(day.startKm),
        highlightEndKm: String(day.endKm),
        dayLabel: `Day ${day.dayNumber}`,
      },
    });
  }, [plan, days, router]);

  // Long press to relocate stop on map
  const handleLongPressDay = useCallback((dayIndex: number) => {
    if (!plan || dayIndex >= stops.length) return;
    const stop = stops[dayIndex];
    router.push({
      pathname: '/plan/map',
      params: {
        trailId: plan.trailId,
        planId: plan.id,
        stopId: stop.id,
        currentKm: String(stop.km),
      },
    });
  }, [plan, stops, router]);

  // Export handlers
  const handleExport = useCallback(() => {
    if (!plan || !trail || days.length === 0) return;
    const exportPlan = {
      name: plan.name,
      trailName: trail.config.name,
      direction: plan.direction,
      totalDays: days.length,
      totalKm: days.reduce((sum, d) => sum + d.distanceKm, 0),
      totalAscent: days.reduce((sum, d) => sum + d.ascentM, 0),
      totalDescent: days.reduce((sum, d) => sum + d.descentM, 0),
    };

    Alert.alert('Export Plan', 'Choose format:', [
      {
        text: 'Share as Text',
        onPress: () => {
          const text = exportPlanAsText(exportPlan, days, dayClimate.some(c => c !== null) ? dayClimate : undefined);
          Share.share({ message: text }).catch(() => {});
        },
      },
      {
        text: 'Share as CSV',
        onPress: () => {
          const csv = exportPlanAsCsv(exportPlan, days, dayClimate.some(c => c !== null) ? dayClimate : undefined);
          Share.share({ message: csv }).catch(() => {});
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [plan, trail, days, dayClimate]);

  // Load versions when versions sheet opens
  const loadVersions = useCallback(async () => {
    if (!planId) return;
    try {
      const service = planServiceRef.current ?? await PlanService.create();
      const list = await service.listPlanVersions(planId);
      setVersions(list);
    } catch { /* ignore */ }
  }, [planId]);

  const handleOpenVersions = useCallback(() => {
    setVersionsOpen(true);
    loadVersions();
  }, [loadVersions]);

  const handleSaveVersion = useCallback(() => {
    if (!planId) return;
    setVersionNameInput('');
    setVersionNameModalOpen(true);
  }, [planId]);

  const handleConfirmSaveVersion = useCallback(async () => {
    if (!planId) return;
    setVersionNameModalOpen(false);
    try {
      const service = planServiceRef.current ?? await PlanService.create();
      await service.savePlanVersion(planId, versionNameInput || undefined);
      loadVersions();
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Failed to save version');
    }
  }, [planId, versionNameInput, loadVersions]);

  const handleLoadVersion = useCallback((version: PlanVersion) => {
    if (!planId) return;
    Alert.alert('Load Version', `Restore "${version.name ?? 'Unnamed'}"? This will overwrite current stops.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Restore',
        onPress: async () => {
          try {
            const service = planServiceRef.current ?? await PlanService.create();
            await service.loadPlanVersion(planId, version.id);
            // Reload plan data
            const loaded = await service.getPlan(planId);
            if (loaded) {
              setStops(migrateStopsJson(loaded.stopsJson));
              if (loaded.sectionJson) {
                try { setSection(JSON.parse(loaded.sectionJson)); } catch { /* ignore */ }
              } else {
                setSection(null);
              }
            }
            setVersionsOpen(false);
          } catch (e) {
            Alert.alert('Error', e instanceof Error ? e.message : 'Failed to load version');
          }
        },
      },
    ]);
  }, [planId]);

  const handleDeleteVersion = useCallback((versionId: string) => {
    Alert.alert('Delete Version', 'Remove this saved version?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            const service = planServiceRef.current ?? await PlanService.create();
            await service.deletePlanVersion(versionId);
            loadVersions();
          } catch { /* ignore */ }
        },
      },
    ]);
  }, [loadVersions]);

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={styles.backButton}
          accessibilityLabel="Go back"
          accessibilityRole="button"
        >
          <Text style={[styles.backText, { color: colors.accent }]}>Back</Text>
        </Pressable>
        <Text style={[styles.title, { color: colors.textPrimary }]} numberOfLines={1}>
          {plan?.name ?? 'Plan'}
        </Text>
        <View style={styles.backButton} />
      </View>

      {/* Save error banner */}
      {saveError && (
        <Text style={[styles.saveError, { color: colors.alertRed, backgroundColor: colors.surface }]}>
          Changes not saved — check storage
        </Text>
      )}

      {/* Dashboard tab bar */}
      <View style={[styles.tabBar, { borderBottomColor: colors.border }]}>
        {(['overview', 'days', 'climate'] as const).map(tab => (
          <Pressable
            key={tab}
            onPress={() => setActiveTab(tab)}
            style={[
              styles.tab,
              activeTab === tab && { borderBottomColor: colors.accent, borderBottomWidth: 2 },
            ]}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeTab === tab }}
          >
            <Text style={[styles.tabText, { color: activeTab === tab ? colors.accent : colors.textSecondary }]}>
              {tab === 'overview' ? 'Overview' : tab === 'days' ? 'Days' : 'Climate'}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Overview tab */}
      {activeTab === 'overview' && trail && (
        <ScrollView contentContainerStyle={styles.list}>
          <PlanSummaryCard
            planName={plan?.name ?? 'Plan'}
            direction={plan?.direction ?? 'NOBO'}
            totalDays={days.length}
            totalKm={days.reduce((sum, d) => sum + d.distanceKm, 0)}
            totalAscent={days.reduce((sum, d) => sum + d.ascentM, 0)}
            totalDescent={days.reduce((sum, d) => sum + d.descentM, 0)}
            startDate={days[0]?.date}
            endDate={days[days.length - 1]?.date}
            section={section ? `km ${section.startKm.toFixed(0)}–${section.endKm.toFixed(0)}` : undefined}
          />

          {/* Quick action buttons */}
          <View style={styles.quickActions}>
            <Pressable
              onPress={() => setSectionSelectorOpen(true)}
              style={[styles.quickAction, { borderColor: colors.border }]}
              accessibilityRole="button"
            >
              <Text style={[styles.quickActionText, { color: colors.accent }]}>
                {section ? 'Change Section' : 'Set Section'}
              </Text>
            </Pressable>
            <Pressable
              onPress={handleExport}
              style={[styles.quickAction, { borderColor: colors.border }]}
              accessibilityRole="button"
            >
              <Text style={[styles.quickActionText, { color: colors.accent }]}>Export</Text>
            </Pressable>
            <Pressable
              onPress={handleOpenVersions}
              style={[styles.quickAction, { borderColor: colors.border }]}
              accessibilityRole="button"
            >
              <Text style={[styles.quickActionText, { color: colors.accent }]}>Versions</Text>
            </Pressable>
          </View>

          {/* Resupply and water summaries */}
          {waterAnalysis && <WaterCarryList analysis={waterAnalysis} />}
          {resupplyAnalysis && <ResupplyList analysis={resupplyAnalysis} days={days} />}
        </ScrollView>
      )}

      {/* Days tab */}
      {activeTab === 'days' && (
        <>
          {days.length === 0 && stops.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>
                No stops planned yet
              </Text>
              <Text style={[styles.emptyBody, { color: colors.textSecondary }]}>
                Tap &ldquo;Add Stops&rdquo; to select overnight stops along the trail.
              </Text>
            </View>
          ) : (
            <FlatList
              data={days}
              keyExtractor={(item) => `day-${item.dayNumber}`}
              contentContainerStyle={styles.list}
              renderItem={({ item, index }) => (
                <DayPlanCard
                  data={dayToCardData(item)}
                  onRemove={index < stops.length ? () => handleRemove(index) : undefined}
                  onMergeUp={index > 0 ? () => handleMergeUp(index) : undefined}
                  onSplit={() => handleSplit(index)}
                  onShowOnMap={() => handleShowOnMap(index)}
                  onLongPress={index < stops.length ? () => handleLongPressDay(index) : undefined}
                  climate={dayClimate[index]}
                />
              )}
            />
          )}
        </>
      )}

      {/* Climate tab */}
      {activeTab === 'climate' && (
        <ScrollView contentContainerStyle={styles.list}>
          {climateData ? (
            <ClimateOverview climate={climateData} planMonths={planMonths} />
          ) : (
            <View style={styles.emptyContainer}>
              <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>No Climate Data</Text>
              <Text style={[styles.emptyBody, { color: colors.textSecondary }]}>
                Climate data is not available for this trail.
              </Text>
            </View>
          )}
        </ScrollView>
      )}

      {/* Add Stops FAB */}
      <Pressable
        onPress={() => setSelectorOpen(true)}
        style={[styles.fab, { backgroundColor: colors.accent, bottom: insets.bottom + spacing.lg }]}
        accessibilityLabel="Add stops"
        accessibilityRole="button"
      >
        <Text style={[styles.fabText, { color: colors.textInverse }]}>+ Add Stops</Text>
      </Pressable>

      {/* Stop selector bottom sheet */}
      <AppBottomSheet
        isOpen={selectorOpen}
        onDismiss={() => setSelectorOpen(false)}
        initialSnap={2}
      >
        <StopSelector
          waypoints={eligibleWaypoints}
          selectedStopKms={selectedStopKms}
          onToggleStop={handleToggleStop}
        />
      </AppBottomSheet>

      {/* Split selector bottom sheet */}
      <AppBottomSheet
        isOpen={splitDay !== null}
        onDismiss={() => setSplitDay(null)}
        initialSnap={1}
      >
        {splitDay && (
          <View>
            <Text style={[styles.splitTitle, { color: colors.textPrimary }]}>
              Split Day {splitDay.dayNumber}
            </Text>
            <Text style={[styles.splitSubtitle, { color: colors.textSecondary }]}>
              Choose a stop between {splitDay.startName} and {splitDay.endName}
            </Text>
            {splitWaypoints.length === 0 ? (
              <Text style={[styles.splitEmpty, { color: colors.textSecondary }]}>
                No eligible stops in this section
              </Text>
            ) : (
              <StopSelector
                waypoints={splitWaypoints}
                selectedStopKms={new Set()}
                onToggleStop={handleSplitSelect}
              />
            )}
          </View>
        )}
      </AppBottomSheet>

      {/* Section selector bottom sheet */}
      {trail && (
        <AppBottomSheet
          isOpen={sectionSelectorOpen}
          onDismiss={() => setSectionSelectorOpen(false)}
          initialSnap={2}
        >
          <SectionSelector
            trail={trail}
            currentSection={section}
            onApply={handleApplySection}
            onDismiss={() => setSectionSelectorOpen(false)}
            onSelectOnMap={handleSelectSectionOnMap}
          />
        </AppBottomSheet>
      )}

      {/* Versions bottom sheet */}
      <AppBottomSheet
        isOpen={versionsOpen}
        onDismiss={() => setVersionsOpen(false)}
        initialSnap={1}
      >
        <View>
          <View style={styles.versionsHeader}>
            <Text style={[styles.splitTitle, { color: colors.textPrimary }]}>Saved Versions</Text>
            <Pressable
              onPress={handleSaveVersion}
              style={[styles.quickAction, { borderColor: colors.accent }]}
              accessibilityRole="button"
            >
              <Text style={[styles.quickActionText, { color: colors.accent }]}>Save Current</Text>
            </Pressable>
          </View>
          {versions.length === 0 ? (
            <Text style={[styles.splitEmpty, { color: colors.textSecondary }]}>
              No saved versions yet
            </Text>
          ) : (
            <FlatList
              data={versions}
              keyExtractor={(v) => v.id}
              scrollEnabled={false}
              renderItem={({ item: v }) => (
                <View style={styles.versionRow}>
                  <Pressable
                    onPress={() => handleLoadVersion(v)}
                    style={styles.versionInfo}
                    accessibilityRole="button"
                    accessibilityLabel={`Load version ${v.name ?? 'Unnamed'}`}
                  >
                    <Text style={[styles.versionName, { color: colors.textPrimary }]} numberOfLines={1}>
                      {v.name ?? 'Unnamed Version'}
                    </Text>
                    <Text style={[styles.versionDate, { color: colors.textSecondary }]}>
                      {new Date(v.createdAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => handleDeleteVersion(v.id)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={`Delete version ${v.name ?? 'Unnamed'}`}
                  >
                    <Text style={[styles.versionDelete, { color: '#c00' }]}>Delete</Text>
                  </Pressable>
                </View>
              )}
            />
          )}
        </View>
      </AppBottomSheet>

      {/* Undo toast */}
      <UndoToast
        visible={undoVisible}
        message={undoMessage}
        onUndo={handleUndo}
        onDismiss={handleUndoDismiss}
      />

      {/* Version name modal (cross-platform replacement for Alert.prompt) */}
      <Modal
        visible={versionNameModalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setVersionNameModalOpen(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: colors.surface }]}>
            <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>Save Version</Text>
            <Text style={[styles.modalMessage, { color: colors.textSecondary }]}>
              Enter a name for this version:
            </Text>
            <TextInput
              style={[styles.modalInput, { color: colors.textPrimary, borderColor: colors.border }]}
              value={versionNameInput}
              onChangeText={setVersionNameInput}
              placeholder="Version name"
              placeholderTextColor={colors.textSecondary}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={handleConfirmSaveVersion}
            />
            <View style={styles.modalButtons}>
              <Pressable
                onPress={() => setVersionNameModalOpen(false)}
                style={styles.modalButton}
                accessibilityRole="button"
              >
                <Text style={[styles.modalButtonText, { color: colors.textSecondary }]}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={handleConfirmSaveVersion}
                style={styles.modalButton}
                accessibilityRole="button"
              >
                <Text style={[styles.modalButtonText, { color: colors.accent }]}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  backButton: {
    minWidth: 50,
    minHeight: touchTarget.min,
    justifyContent: 'center',
  },
  backText: {
    ...typography.body,
    fontWeight: '600',
  },
  title: {
    ...typography.titleLarge,
    flex: 1,
    textAlign: 'center',
  },
  saveError: {
    ...typography.caption,
    fontWeight: '600',
    textAlign: 'center',
    paddingVertical: spacing.xs,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    borderRadius: radii.sm,
    overflow: 'hidden',
  },
  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    marginHorizontal: spacing.lg,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm,
    minHeight: touchTarget.min,
    justifyContent: 'center',
  },
  tabText: {
    ...typography.caption,
    fontWeight: '600',
  },
  quickActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  quickAction: {
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: touchTarget.min,
    justifyContent: 'center',
  },
  quickActionText: {
    ...typography.caption,
    fontWeight: '600',
  },
  list: {
    padding: spacing.lg,
    paddingBottom: 100,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  emptyTitle: {
    ...typography.titleLarge,
    marginBottom: spacing.sm,
  },
  emptyBody: {
    ...typography.body,
    textAlign: 'center',
  },
  fab: {
    position: 'absolute',
    right: spacing.lg,
    borderRadius: radii.xl,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },
  fabText: {
    ...typography.body,
    fontWeight: '700',
  },
  splitTitle: {
    ...typography.titleLarge,
    marginBottom: spacing.xs,
  },
  splitSubtitle: {
    ...typography.caption,
    marginBottom: spacing.lg,
  },
  splitEmpty: {
    ...typography.body,
    textAlign: 'center',
    marginTop: spacing.xl,
  },
  versionsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  versionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: touchTarget.min,
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(0,0,0,0.08)',
  },
  versionInfo: {
    flex: 1,
    marginRight: spacing.md,
  },
  versionName: {
    ...typography.body,
    fontWeight: '500',
  },
  versionDate: {
    ...typography.caption,
    marginTop: 2,
  },
  versionDelete: {
    ...typography.caption,
    fontWeight: '600',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl,
  },
  modalContent: {
    width: '100%',
    maxWidth: 320,
    borderRadius: radii.lg,
    padding: spacing.lg,
  },
  modalTitle: {
    ...typography.titleLarge,
    marginBottom: spacing.xs,
  },
  modalMessage: {
    ...typography.body,
    marginBottom: spacing.md,
  },
  modalInput: {
    ...typography.body,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.md,
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.md,
  },
  modalButton: {
    minHeight: touchTarget.min,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  modalButtonText: {
    ...typography.body,
    fontWeight: '600',
  },
});
