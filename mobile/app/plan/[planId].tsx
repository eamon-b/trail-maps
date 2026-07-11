import { useCallback, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Share,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../src/theme';
import { usePlanEditor } from '../../src/hooks/usePlanEditor';
import { ScreenHeader } from '../../src/components/ScreenHeader';
import { PlanDaysTab } from '../../src/components/plan/PlanDaysTab';
import { PlanOverviewTab } from '../../src/components/plan/PlanOverviewTab';
import { PlanClimateTab } from '../../src/components/plan/PlanClimateTab';
import { PlanSheets } from '../../src/components/plan/PlanSheets';
import type { PlanVersion } from '../../src/services/plan-service';
import { exportPlanAsText, exportPlanAsCsv } from '../../src/services/plan-export';
import { buildPickerParams } from '../../src/lib/point-picker-contract';
import { spacing, radii, touchTarget } from '../../src/tokens/spacing';
import { typography } from '../../src/tokens/typography';

type DashboardTab = 'overview' | 'days' | 'climate';

/**
 * Plan editor screen. Routing, tab, and sheet-visibility state live here;
 * data/domain logic is in usePlanEditor; the tabs and sheets are extracted
 * components (WS4 structural split — no behavior change).
 */
export default function PlanEditorScreen() {
  const { planId, trailId: paramTrailId } = useLocalSearchParams<{ planId: string; trailId?: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const editor = usePlanEditor(planId, paramTrailId, () => router.back());
  const {
    plan, trail, stops, section, loading, saveError,
    days, waterAnalysis, resupplyAnalysis, dayResources,
    selectedStopKms, eligibleWaypoints, dayClimate, planMonths,
    climateData, isCustomTrail, climateFetch, handleFetchClimate,
    stopIndexEndingDay, handleToggleStop, handleRemove, handleMergeUp,
    handleSplit, splitDay, setSplitDay, splitWaypoints, handleSplitSelect,
    applySection,
    undoVisible, undoMessage, handleUndo, handleUndoDismiss,
    versions, loadVersions, saveVersion, restoreVersion, deleteVersion,
  } = editor;

  // Sheet visibility
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [sectionSelectorOpen, setSectionSelectorOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);

  // Day-actions menu (⋯ on a day card)
  const [menuDayIndex, setMenuDayIndex] = useState<number | null>(null);

  // Dashboard tabs
  const [activeTab, setActiveTab] = useState<DashboardTab>('days');

  // ---------------------------------------------------------------------
  // Navigation handlers (map picker)
  // ---------------------------------------------------------------------

  const handleApplySection = useCallback((newSection: Parameters<typeof applySection>[0]) => {
    applySection(newSection);
    setSectionSelectorOpen(false);
  }, [applySection]);

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

  // ---------------------------------------------------------------------
  // Day-actions menu handlers (labeled equivalents of the gesture shortcuts)
  // ---------------------------------------------------------------------

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

  // ---------------------------------------------------------------------
  // Export / versions
  // ---------------------------------------------------------------------

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

  const handleOpenVersions = useCallback(() => {
    setVersionsOpen(true);
    loadVersions();
  }, [loadVersions]);

  const handleLoadVersion = useCallback((version: PlanVersion) => {
    restoreVersion(version, () => setVersionsOpen(false));
  }, [restoreVersion]);

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

      {activeTab === 'overview' && trail && (
        <PlanOverviewTab
          plan={plan}
          days={days}
          section={section}
          waterAnalysis={waterAnalysis}
          resupplyAnalysis={resupplyAnalysis}
          onSetSection={() => setSectionSelectorOpen(true)}
          onExport={handleExport}
          onOpenVersions={handleOpenVersions}
        />
      )}

      {activeTab === 'days' && (
        <PlanDaysTab
          days={days}
          stopsCount={stops.length}
          dayClimate={dayClimate}
          dayResources={dayResources}
          onRemoveDay={handleRemove}
          onOpenMenu={setMenuDayIndex}
          onShowOnMap={handleShowOnMap}
          onLongPressDay={handleLongPressDay}
          onResourcePress={() => setActiveTab('overview')}
        />
      )}

      {activeTab === 'climate' && (
        <PlanClimateTab
          climateData={climateData}
          isCustomTrail={isCustomTrail}
          climateFetch={climateFetch}
          onFetchClimate={handleFetchClimate}
          planMonths={planMonths}
        />
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

      <PlanSheets
        trail={trail}
        days={days}
        selectorOpen={selectorOpen}
        onCloseSelector={() => setSelectorOpen(false)}
        eligibleWaypoints={eligibleWaypoints}
        selectedStopKms={selectedStopKms}
        onToggleStop={handleToggleStop}
        menuDayIndex={menuDayIndex}
        onCloseDayMenu={closeDayMenu}
        onMenuSplit={handleMenuSplit}
        onMenuMerge={handleMenuMerge}
        onMenuMove={handleMenuMove}
        onMenuRemove={handleMenuRemove}
        splitDay={splitDay}
        onCloseSplit={() => setSplitDay(null)}
        splitWaypoints={splitWaypoints}
        onSplitSelect={handleSplitSelect}
        section={section}
        sectionSelectorOpen={sectionSelectorOpen}
        onCloseSectionSelector={() => setSectionSelectorOpen(false)}
        onApplySection={handleApplySection}
        onSelectSectionOnMap={handleSelectSectionOnMap}
        versionsOpen={versionsOpen}
        onCloseVersions={() => setVersionsOpen(false)}
        versions={versions}
        onSaveVersion={saveVersion}
        onLoadVersion={handleLoadVersion}
        onDeleteVersion={deleteVersion}
        undoVisible={undoVisible}
        undoMessage={undoMessage}
        onUndo={handleUndo}
        onUndoDismiss={handleUndoDismiss}
      />
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
});
