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
  createReversedTrail,
  type Trail,
  type TrailWaypoint,
} from '../../src/lib/trail-utils';
import { computeDays, addStop, removeStop } from '@lib/day-calculator';
import type { StopData, SectionConfig, ComputedDay } from '../../src/services/plan-calculator-types';
import { DayPlanCard, type DayPlanData, type DayResources } from '../../src/components/DayPlanCard';
import { PressableRow } from '../../src/components/PressableRow';
import { PlanSummaryCard } from '../../src/components/PlanSummaryCard';
import { StopSelector } from '../../src/components/StopSelector';
import { SectionSelector } from '../../src/components/SectionSelector';
import { ClimateOverview } from '../../src/components/ClimateOverview';
import { AppBottomSheet } from '../../src/components/AppBottomSheet';
import { ScreenHeader } from '../../src/components/ScreenHeader';
import { Card } from '../../src/components/Card';
import { UndoToast } from '../../src/components/UndoToast';
import { WaterCarryList } from '../../src/components/WaterCarryList';
import { ResupplyList } from '../../src/components/ResupplyList';
import { analyzeWaterCarry, analyzeWaterCarryForSection } from '@lib/water-carry-calculator';
import { analyzeResupply, analyzeResupplyForSection } from '@lib/resupply-calculator';
import { ensureClimateData, getClimateForDay, type ClimateData, type DayClimate } from '../../src/services/climate-service';
import {
  ensureCustomTrailClimate,
  type ClimateFetchProgress,
} from '../../src/services/custom-climate-service';
import { exportPlanAsText, exportPlanAsCsv } from '../../src/services/plan-export';
import { generateId, migrateStopsJson } from '../../src/services/plan-utils';
import { buildPickerParams } from '../../src/lib/point-picker-contract';
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

  // Day-actions menu (⋯ on a day card)
  const [menuDayIndex, setMenuDayIndex] = useState<number | null>(null);

  // Dashboard tabs
  const [activeTab, setActiveTab] = useState<DashboardTab>('days');

  // Section selector
  const [sectionSelectorOpen, setSectionSelectorOpen] = useState(false);

  // Climate data
  const [climateData, setClimateData] = useState<ClimateData | null>(null);
  const [isCustomTrail, setIsCustomTrail] = useState(false);
  const [climateFetch, setClimateFetch] = useState<{
    status: 'idle' | 'loading' | 'error';
    progress?: ClimateFetchProgress;
  }>({ status: 'idle' });
  // Unreversed trail (as stored) — climate sample positions are cached in
  // NOBO km-space, matching bundled climate data.
  const baseTrailRef = useRef<Trail | null>(null);


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
        let parsed = await trailService.getMergedTrail(tId);
        if (!parsed) {
          Alert.alert('Error', 'Trail data not found');
          router.back();
          return;
        }

        baseTrailRef.current = parsed;
        if (loaded.direction === 'SOBO') {
          parsed = createReversedTrail(parsed);
        }
        setTrail(parsed);

        const dbRow = await trailService.getTrail(tId);
        setIsCustomTrail(dbRow?.isCustom ?? false);

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

  // Load climate data when trail is available. ensureClimateData is
  // registry-first (bundled trails) then falls back to the SQLite climate cache
  // (custom trails); network fetches remain strictly user-triggered.
  useEffect(() => {
    if (!plan?.trailId) return;
    const trailId = plan.trailId;

    let cancelled = false;
    ensureClimateData(trailId)
      .then((data) => {
        if (!cancelled) setClimateData(data);
      })
      .catch(() => { /* no cached climate */ });
    return () => { cancelled = true; };
  }, [plan?.trailId]);

  // User-triggered climate fetch for custom trails (requires internet)
  const handleFetchClimate = useCallback(async () => {
    const trailId = plan?.trailId;
    const baseTrail = baseTrailRef.current;
    if (!trailId || !baseTrail) return;

    setClimateFetch({ status: 'loading' });
    // Defensive: even though ensureCustomTrailClimate resolves to null on
    // failure, guard the await so an unexpected throw can never strand the
    // spinner on 'loading' with no retry affordance.
    try {
      const data = await ensureCustomTrailClimate(trailId, baseTrail, (progress) => {
        setClimateFetch({ status: 'loading', progress });
      });
      if (data) {
        setClimateData(data);
        setClimateFetch({ status: 'idle' });
      } else {
        setClimateFetch({ status: 'error' });
      }
    } catch {
      setClimateFetch({ status: 'error' });
    }
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

  // Per-day water-carry / resupply strip data
  const dayResources = useMemo((): DayResources[] => {
    return days.map((d) => {
      let maxCarryKm: number | null = null;
      if (waterAnalysis?.hasWaterData) {
        for (const gap of waterAnalysis.gaps) {
          // A gap that overlaps this day means the carry applies to it
          if (gap.fromKm < d.endKm && gap.toKm > d.startKm) {
            maxCarryKm = Math.max(maxCarryKm ?? 0, gap.distanceKm);
          }
        }
      }
      const hasResupply = !!resupplyAnalysis?.points.some(
        (pt) => pt.km > d.startKm && pt.km <= d.endKm,
      );
      return { maxCarryKm, hasResupply };
    });
  }, [days, waterAnalysis, resupplyAnalysis]);

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

  // Resolve the stop that ends a given day. computeDays sorts stops and clamps
  // them to the plan/section range, so day index and stops[] index can diverge
  // (section plans, stops at exactly km 0 / trail end) — match on the day's
  // end-boundary km instead of position. The last day ends at the range end,
  // not a stop, so this returns -1 for it.
  const stopIndexEndingDay = useCallback((dayIndex: number): number => {
    const endKm = days[dayIndex]?.endKm;
    if (endKm === undefined) return -1;
    return stops.findIndex(s => s.km === endKm);
  }, [days, stops]);

  // Handle remove (swipe-to-delete on a day card)
  const handleRemove = useCallback((dayIndex: number) => {
    const stopIdx = stopIndexEndingDay(dayIndex);
    if (stopIdx < 0) return;

    undoStopsRef.current = stops;
    const stop = stops[stopIdx];
    const removedName = stop.customLocation?.name ?? stop.waypointName ?? 'Stop';
    const newStops = removeStop(stops, stopIdx);
    updateStops(newStops);
    setUndoMessage(`Removed ${removedName}`);
    setUndoVisible(true);
  }, [stops, stopIndexEndingDay, updateStops]);

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
    // Day N merges with Day N-1 by removing the stop that ends Day N-1
    if (dayIndex < 1) return;
    const stopIdx = stopIndexEndingDay(dayIndex - 1);
    if (stopIdx < 0) return;
    const stop = stops[stopIdx];
    const removedName = stop.customLocation?.name ?? stop.waypointName ?? 'Stop';
    undoStopsRef.current = stops;
    const newStops = removeStop(stops, stopIdx);
    updateStops(newStops);
    setUndoMessage(`Merged at ${removedName}`);
    setUndoVisible(true);
  }, [stops, stopIndexEndingDay, updateStops]);

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
      pathname: '/plan/point-picker',
      params: buildPickerParams({
        mode: 'section',
        trailId: plan.trailId,
        planId: plan.id,
        direction: plan.direction,
        currentStartKm: section?.startKm,
        currentEndKm: section?.endKm,
      }),
    });
  }, [plan, section, router]);

  // Show on map handler — navigate to map with the day's segment highlighted
  const handleShowOnMap = useCallback((dayIndex: number) => {
    if (!plan || dayIndex >= days.length) return;
    const day = days[dayIndex];
    router.push({
      pathname: '/plan/point-picker',
      params: buildPickerParams({
        mode: 'day',
        trailId: plan.trailId,
        planId: plan.id,
        highlightStartKm: day.startKm,
        highlightEndKm: day.endKm,
        dayLabel: `Day ${day.dayNumber}`,
      }),
    });
  }, [plan, days, router]);

  // Long press to relocate stop on map
  const handleLongPressDay = useCallback((dayIndex: number) => {
    if (!plan) return;
    const stopIdx = stopIndexEndingDay(dayIndex);
    if (stopIdx < 0) return;
    const stop = stops[stopIdx];
    router.push({
      pathname: '/plan/point-picker',
      params: buildPickerParams({
        mode: 'relocate',
        trailId: plan.trailId,
        planId: plan.id,
        stopId: stop.id,
        currentKm: stop.km,
      }),
    });
  }, [plan, stops, stopIndexEndingDay, router]);

  // Day-actions menu handlers (labeled equivalents of the gesture shortcuts)
  const menuDay = menuDayIndex != null ? days[menuDayIndex] : null;
  const closeDayMenu = useCallback(() => setMenuDayIndex(null), []);

  const handleMenuSplit = useCallback(() => {
    if (menuDayIndex == null) return;
    closeDayMenu();
    handleSplit(menuDayIndex);
  }, [menuDayIndex, closeDayMenu, handleSplit]);

  const handleMenuMerge = useCallback(() => {
    if (menuDayIndex == null) return;
    closeDayMenu();
    handleMergeUp(menuDayIndex);
  }, [menuDayIndex, closeDayMenu, handleMergeUp]);

  const handleMenuMove = useCallback(() => {
    if (menuDayIndex == null) return;
    closeDayMenu();
    handleLongPressDay(menuDayIndex);
  }, [menuDayIndex, closeDayMenu, handleLongPressDay]);

  const handleMenuRemove = useCallback(() => {
    if (menuDayIndex == null) return;
    closeDayMenu();
    handleRemove(menuDayIndex);
  }, [menuDayIndex, closeDayMenu, handleRemove]);

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
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenHeader title={plan?.name ?? 'Plan'} onBack={() => router.back()} />

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
                Tap &quot;Add Stops&quot; to select overnight stops along the trail.
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
                  onRemove={index < days.length - 1 ? () => handleRemove(index) : undefined}
                  onOpenMenu={() => setMenuDayIndex(index)}
                  onShowOnMap={() => handleShowOnMap(index)}
                  onLongPress={index < days.length - 1 ? () => handleLongPressDay(index) : undefined}
                  climate={dayClimate[index]}
                  resources={dayResources[index]}
                  onResourcePress={() => setActiveTab('overview')}
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
          ) : isCustomTrail ? (
            <Card>
              <Text style={[styles.climateFetchTitle, { color: colors.textPrimary }]}>
                No Climate Data Yet
              </Text>
              {climateFetch.status === 'loading' ? (
                <View style={styles.climateFetchProgress}>
                  <ActivityIndicator size="small" color={colors.accent} />
                  <Text style={[styles.climateFetchBody, { color: colors.textSecondary }]}>
                    {climateFetch.progress
                      ? `Fetching ${climateFetch.progress.locationName} (${climateFetch.progress.current}/${climateFetch.progress.total})...`
                      : 'Fetching climate data...'}
                  </Text>
                </View>
              ) : (
                <>
                  <Text style={[styles.climateFetchBody, { color: colors.textSecondary }]}>
                    {climateFetch.status === 'error'
                      ? 'Could not fetch climate data. Check your internet connection and try again.'
                      : 'Climate data requires a one-time internet fetch. Historical averages are downloaded for a few points along the trail and stored on your device for offline use.'}
                  </Text>
                  <Pressable
                    onPress={handleFetchClimate}
                    style={[styles.climateFetchButton, { backgroundColor: colors.accent }]}
                    accessibilityRole="button"
                    accessibilityLabel="Fetch climate data"
                  >
                    <Text style={[styles.climateFetchButtonText, { color: colors.textInverse }]}>
                      {climateFetch.status === 'error' ? 'Retry' : 'Fetch Climate Data'}
                    </Text>
                  </Pressable>
                </>
              )}
            </Card>
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

      {/* Day actions menu (labeled verbs; gestures remain as shortcuts) */}
      <AppBottomSheet
        isOpen={menuDayIndex !== null}
        onDismiss={closeDayMenu}
        initialSnap={0}
        snapPoints={['40%', '60%']}
      >
        {menuDay && menuDayIndex != null && (
          <View>
            <Text style={[styles.splitTitle, { color: colors.textPrimary }]}>
              Day {menuDay.dayNumber}
            </Text>
            <Text style={[styles.splitSubtitle, { color: colors.textSecondary }]}>
              {menuDay.startName} → {menuDay.endName}
            </Text>
            <PressableRow
              onPress={handleMenuSplit}
              accessibilityLabel={`Split day ${menuDay.dayNumber}`}
              style={styles.menuRow}
            >
              <Text style={[styles.menuRowText, { color: colors.textPrimary }]}>Split day…</Text>
            </PressableRow>
            {menuDayIndex > 0 && (
              <PressableRow
                onPress={handleMenuMerge}
                accessibilityLabel="Merge with previous day"
                style={[styles.menuRow, { borderTopColor: colors.border }]}
                bordered={false}
              >
                <Text style={[styles.menuRowText, { color: colors.textPrimary }]}>Merge with previous</Text>
              </PressableRow>
            )}
            {menuDayIndex < days.length - 1 && (
              <PressableRow
                onPress={handleMenuMove}
                accessibilityLabel="Move this day's stop on the map"
                style={styles.menuRow}
              >
                <Text style={[styles.menuRowText, { color: colors.textPrimary }]}>Move stop…</Text>
              </PressableRow>
            )}
            {menuDayIndex < days.length - 1 && (
              <PressableRow
                onPress={handleMenuRemove}
                haptic="warning"
                accessibilityLabel="Remove this day's stop"
                style={styles.menuRow}
              >
                <Text style={[styles.menuRowText, { color: colors.danger }]}>Remove stop</Text>
              </PressableRow>
            )}
          </View>
        )}
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
            <>
              {versions.map((v) => (
                <View key={v.id} style={[styles.versionRow, { borderBottomColor: colors.border }]}>
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
                    <Text style={[styles.versionDelete, { color: colors.danger }]}>Delete</Text>
                  </Pressable>
                </View>
              ))}
            </>
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
        <View style={[styles.modalOverlay, { backgroundColor: colors.scrim }]}>
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
  climateFetchTitle: {
    ...typography.titleLarge,
    marginBottom: spacing.sm,
  },
  climateFetchBody: {
    ...typography.body,
    lineHeight: 20,
  },
  climateFetchProgress: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  climateFetchButton: {
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.lg,
    minHeight: touchTarget.min,
    justifyContent: 'center',
  },
  climateFetchButtonText: {
    ...typography.body,
    fontWeight: '700',
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
  menuRow: {
    paddingHorizontal: spacing.sm,
    borderTopWidth: 0,
  },
  menuRowText: {
    ...typography.body,
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
