import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { PlanService, type Plan, type PlanVersion } from '../services/plan-service';
import { TrailDataService } from '../services/trail-data-service';
import { createReversedTrail, type Trail, type TrailWaypoint } from '../lib/trail-utils';
import { computeDays, addStop, removeStop } from '@lib/day-calculator';
import { analyzeWaterCarry, analyzeWaterCarryForSection } from '@lib/water-carry-calculator';
import { analyzeResupply, analyzeResupplyForSection } from '@lib/resupply-calculator';
import {
  ensureClimateData,
  getClimateForDay,
  type ClimateData,
  type DayClimate,
} from '../services/climate-service';
import {
  ensureCustomTrailClimate,
  type ClimateFetchProgress,
} from '../services/custom-climate-service';
import { generateId, migrateStopsJson } from '../services/plan-utils';
import type { StopData, SectionConfig, ComputedDay } from '../services/plan-calculator-types';
import type { DayResources } from '../components/DayPlanCard';

export interface ClimateFetchState {
  status: 'idle' | 'loading' | 'error';
  progress?: ClimateFetchProgress;
}

/**
 * Data/domain owner for the plan editor screen (extracted from
 * app/plan/[planId].tsx — WS4, no behavior change).
 *
 * Owns: load + persistence, undo, split/merge/remove stop editing, section
 * config, per-day derived data (days, climate, water/resupply), and plan
 * versions. Navigation and sheet-visibility state stay in the screen.
 */
export function usePlanEditor(planId: string | undefined, paramTrailId: string | undefined, onLoadFailed: () => void) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [trail, setTrail] = useState<Trail | null>(null);
  const [stops, setStops] = useState<StopData[]>([]);
  const [section, setSection] = useState<SectionConfig | null>(null);
  const [loading, setLoading] = useState(true);

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

  // Climate data
  const [climateData, setClimateData] = useState<ClimateData | null>(null);
  const [isCustomTrail, setIsCustomTrail] = useState(false);
  const [climateFetch, setClimateFetch] = useState<ClimateFetchState>({ status: 'idle' });
  // Unreversed trail (as stored) — climate sample positions are cached in
  // NOBO km-space, matching bundled climate data.
  const baseTrailRef = useRef<Trail | null>(null);

  // Versioning
  const [versions, setVersions] = useState<PlanVersion[]>([]);

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
          onLoadFailed();
          return;
        }
        setPlan(loaded);

        const tId = loaded.trailId || paramTrailId;
        if (!tId) {
          Alert.alert('Error', 'No trail associated with this plan');
          onLoadFailed();
          return;
        }

        const trailService = await TrailDataService.create();
        let parsed = await trailService.getMergedTrail(tId);
        if (!parsed) {
          Alert.alert('Error', 'Trail data not found');
          onLoadFailed();
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
    // onLoadFailed is a navigation callback; identity changes must not re-run the load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planId, paramTrailId]);

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

  // Apply + persist a section config
  const applySection = useCallback(async (newSection: SectionConfig | null) => {
    setSection(newSection);
    if (!planId) return;
    try {
      const service = planServiceRef.current ?? await PlanService.create();
      await service.updatePlan(planId, { sectionJson: newSection ? JSON.stringify(newSection) : null });
    } catch (e) {
      console.warn('Failed to persist section:', e);
    }
  }, [planId]);

  // ---------------------------------------------------------------------
  // Versions
  // ---------------------------------------------------------------------

  const loadVersions = useCallback(async () => {
    if (!planId) return;
    try {
      const service = planServiceRef.current ?? await PlanService.create();
      const list = await service.listPlanVersions(planId);
      setVersions(list);
    } catch { /* ignore */ }
  }, [planId]);

  const saveVersion = useCallback(async (name?: string) => {
    if (!planId) return;
    try {
      const service = planServiceRef.current ?? await PlanService.create();
      await service.savePlanVersion(planId, name || undefined);
      loadVersions();
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Failed to save version');
    }
  }, [planId, loadVersions]);

  const restoreVersion = useCallback((version: PlanVersion, onRestored?: () => void) => {
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
            onRestored?.();
          } catch (e) {
            Alert.alert('Error', e instanceof Error ? e.message : 'Failed to load version');
          }
        },
      },
    ]);
  }, [planId]);

  const deleteVersion = useCallback((versionId: string) => {
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

  return {
    // Data
    plan,
    trail,
    stops,
    section,
    loading,
    saveError,
    isCustomTrail,
    // Derived
    days,
    waterAnalysis,
    resupplyAnalysis,
    dayResources,
    selectedStopKms,
    eligibleWaypoints,
    dayClimate,
    planMonths,
    climateData,
    climateFetch,
    // Editing
    stopIndexEndingDay,
    handleToggleStop,
    handleRemove,
    handleMergeUp,
    handleSplit,
    splitDay,
    setSplitDay,
    splitWaypoints,
    handleSplitSelect,
    applySection,
    handleFetchClimate,
    // Undo
    undoVisible,
    undoMessage,
    handleUndo,
    handleUndoDismiss,
    // Versions
    versions,
    loadVersions,
    saveVersion,
    restoreVersion,
    deleteVersion,
  };
}

export type PlanEditor = ReturnType<typeof usePlanEditor>;
