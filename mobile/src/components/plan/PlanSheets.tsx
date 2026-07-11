import React, { useCallback, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '../../theme';
import { AppBottomSheet } from '../AppBottomSheet';
import { StopSelector } from '../StopSelector';
import { SectionSelector } from '../SectionSelector';
import { PressableRow } from '../PressableRow';
import { UndoToast } from '../UndoToast';
import type { Trail, TrailWaypoint } from '../../lib/trail-utils';
import type { ComputedDay, SectionConfig } from '../../services/plan-calculator-types';
import type { PlanVersion } from '../../services/plan-service';
import { spacing, radii, touchTarget } from '../../tokens/spacing';
import { typography } from '../../tokens/typography';

interface PlanSheetsProps {
  trail: Trail | null;
  days: ComputedDay[];

  // Stop selector sheet
  selectorOpen: boolean;
  onCloseSelector: () => void;
  eligibleWaypoints: TrailWaypoint[];
  selectedStopKms: Set<number>;
  onToggleStop: (wp: TrailWaypoint) => void;

  // Day actions menu
  menuDayIndex: number | null;
  onCloseDayMenu: () => void;
  onMenuSplit: () => void;
  onMenuMerge: () => void;
  onMenuMove: () => void;
  onMenuRemove: () => void;

  // Split sheet
  splitDay: ComputedDay | null;
  onCloseSplit: () => void;
  splitWaypoints: TrailWaypoint[];
  onSplitSelect: (wp: TrailWaypoint) => void;

  // Section selector sheet
  section: SectionConfig | null;
  sectionSelectorOpen: boolean;
  onCloseSectionSelector: () => void;
  onApplySection: (section: SectionConfig | null) => void;
  onSelectSectionOnMap: () => void;

  // Versions sheet
  versionsOpen: boolean;
  onCloseVersions: () => void;
  versions: PlanVersion[];
  onSaveVersion: (name?: string) => void;
  onLoadVersion: (version: PlanVersion) => void;
  onDeleteVersion: (versionId: string) => void;

  // Undo toast
  undoVisible: boolean;
  undoMessage: string;
  onUndo: () => void;
  onUndoDismiss: () => void;
}

/**
 * Host for every bottom sheet / toast / modal on the plan editor screen
 * (extracted from app/plan/[planId].tsx — WS4, no behavior change).
 * Owns only the version-name input modal's local state.
 */
export function PlanSheets({
  trail,
  days,
  selectorOpen,
  onCloseSelector,
  eligibleWaypoints,
  selectedStopKms,
  onToggleStop,
  menuDayIndex,
  onCloseDayMenu,
  onMenuSplit,
  onMenuMerge,
  onMenuMove,
  onMenuRemove,
  splitDay,
  onCloseSplit,
  splitWaypoints,
  onSplitSelect,
  section,
  sectionSelectorOpen,
  onCloseSectionSelector,
  onApplySection,
  onSelectSectionOnMap,
  versionsOpen,
  onCloseVersions,
  versions,
  onSaveVersion,
  onLoadVersion,
  onDeleteVersion,
  undoVisible,
  undoMessage,
  onUndo,
  onUndoDismiss,
}: PlanSheetsProps) {
  const { colors } = useTheme();

  // Version name modal (cross-platform replacement for Alert.prompt)
  const [versionNameModalOpen, setVersionNameModalOpen] = useState(false);
  const [versionNameInput, setVersionNameInput] = useState('');

  const handleSaveVersion = useCallback(() => {
    setVersionNameInput('');
    setVersionNameModalOpen(true);
  }, []);

  const handleConfirmSaveVersion = useCallback(() => {
    setVersionNameModalOpen(false);
    onSaveVersion(versionNameInput || undefined);
  }, [onSaveVersion, versionNameInput]);

  const menuDay = menuDayIndex != null ? days[menuDayIndex] : null;

  return (
    <>
      {/* Stop selector bottom sheet */}
      <AppBottomSheet
        isOpen={selectorOpen}
        onDismiss={onCloseSelector}
        initialSnap={2}
      >
        <StopSelector
          waypoints={eligibleWaypoints}
          selectedStopKms={selectedStopKms}
          onToggleStop={onToggleStop}
        />
      </AppBottomSheet>

      {/* Day actions menu (labeled verbs; gestures remain as shortcuts) */}
      <AppBottomSheet
        isOpen={menuDayIndex !== null}
        onDismiss={onCloseDayMenu}
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
              onPress={onMenuSplit}
              accessibilityLabel={`Split day ${menuDay.dayNumber}`}
              style={styles.menuRow}
            >
              <Text style={[styles.menuRowText, { color: colors.textPrimary }]}>Split day…</Text>
            </PressableRow>
            {menuDayIndex > 0 && (
              <PressableRow
                onPress={onMenuMerge}
                accessibilityLabel="Merge with previous day"
                style={styles.menuRow}
              >
                <Text style={[styles.menuRowText, { color: colors.textPrimary }]}>Merge with previous</Text>
              </PressableRow>
            )}
            {menuDayIndex < days.length - 1 && (
              <PressableRow
                onPress={onMenuMove}
                accessibilityLabel="Move this day's stop on the map"
                style={styles.menuRow}
              >
                <Text style={[styles.menuRowText, { color: colors.textPrimary }]}>Move stop…</Text>
              </PressableRow>
            )}
            {menuDayIndex < days.length - 1 && (
              <PressableRow
                onPress={onMenuRemove}
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
        onDismiss={onCloseSplit}
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
                onToggleStop={onSplitSelect}
              />
            )}
          </View>
        )}
      </AppBottomSheet>

      {/* Section selector bottom sheet */}
      {trail && (
        <AppBottomSheet
          isOpen={sectionSelectorOpen}
          onDismiss={onCloseSectionSelector}
          initialSnap={2}
        >
          <SectionSelector
            trail={trail}
            currentSection={section}
            onApply={onApplySection}
            onDismiss={onCloseSectionSelector}
            onSelectOnMap={onSelectSectionOnMap}
          />
        </AppBottomSheet>
      )}

      {/* Versions bottom sheet */}
      <AppBottomSheet
        isOpen={versionsOpen}
        onDismiss={onCloseVersions}
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
                    onPress={() => onLoadVersion(v)}
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
                    onPress={() => onDeleteVersion(v.id)}
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
        onUndo={onUndo}
        onDismiss={onUndoDismiss}
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
    </>
  );
}

const styles = StyleSheet.create({
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
  menuRow: {
    paddingHorizontal: spacing.sm,
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
