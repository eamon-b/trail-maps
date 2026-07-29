/**
 * Route-builder toolbar + save prompt.
 *
 * Shown pinned to the bottom of the map pane while the builder is active. Left
 * side reads the running total distance + point count; right side offers Undo,
 * Cancel, and Save. Save opens an inline name modal (the same lightweight
 * pattern the waypoint composer uses for the display-name prompt) and only then
 * commits, so an unnamed tap never persists a route.
 */

import React, { useCallback, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { formatDistance, type DistanceUnit } from '@lib/format-distance';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';

export interface RouteBuilderBarProps {
  totalKm: number;
  pointCount: number;
  unit: DistanceUnit;
  onUndo: () => void;
  onCancel: () => void;
  /** Commit the route under a chosen name (already trimmed, non-empty). */
  onSave: (name: string) => void;
}

/** A route needs at least two points before it can be saved. */
const MIN_POINTS = 2;

export function RouteBuilderBar({
  totalKm,
  pointCount,
  unit,
  onUndo,
  onCancel,
  onSave,
}: RouteBuilderBarProps) {
  const { colors } = useTheme();
  const [promptOpen, setPromptOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  const canUndo = pointCount > 0;
  const canSave = pointCount >= MIN_POINTS;

  const confirmSave = useCallback(() => {
    const name = nameDraft.trim();
    if (name.length === 0) return;
    setPromptOpen(false);
    setNameDraft('');
    onSave(name);
  }, [nameDraft, onSave]);

  return (
    <View
      style={[styles.bar, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}
    >
      <View style={styles.readout}>
        <Text style={[styles.km, { color: colors.textPrimary }]}>
          {formatDistance(totalKm, unit)}
        </Text>
        <Text style={[styles.count, { color: colors.textSecondary }]}>
          {pointCount} {pointCount === 1 ? 'point' : 'points'}
        </Text>
      </View>

      <View style={styles.actions}>
        <BarButton label="Undo" onPress={onUndo} disabled={!canUndo} tone="neutral" />
        <BarButton label="Cancel" onPress={onCancel} tone="neutral" />
        <BarButton label="Save" onPress={() => setPromptOpen(true)} disabled={!canSave} tone="accent" />
      </View>

      <Modal
        visible={promptOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setPromptOpen(false)}
      >
        <View style={[styles.modalBackdrop, { backgroundColor: colors.scrim }]}>
          <View style={[styles.modalCard, { backgroundColor: colors.surfaceElevated }]}>
            <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>Name this route</Text>
            <Text style={[styles.modalHint, { color: colors.textSecondary }]}>
              {formatDistance(totalKm, unit)} · {pointCount} points
            </Text>
            <TextInput
              style={[styles.input, { color: colors.textPrimary, borderColor: colors.border }]}
              placeholder="e.g. Day 1 – Redbank Gorge"
              placeholderTextColor={colors.textSecondary}
              value={nameDraft}
              onChangeText={setNameDraft}
              autoFocus
              maxLength={60}
            />
            <View style={styles.modalActions}>
              <Pressable
                onPress={() => setPromptOpen(false)}
                accessibilityRole="button"
                style={styles.modalButton}
              >
                <Text style={[styles.link, { color: colors.textSecondary }]}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={confirmSave}
                disabled={nameDraft.trim().length === 0}
                accessibilityRole="button"
                accessibilityLabel="Save route"
                style={[styles.modalButton, styles.modalSave, { backgroundColor: colors.accent }]}
              >
                <Text style={[styles.saveText, { color: colors.accentText }]}>Save</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function BarButton({
  label,
  onPress,
  disabled,
  tone,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone: 'neutral' | 'accent';
}) {
  const { colors } = useTheme();
  const accent = tone === 'accent';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [
        styles.button,
        accent && { backgroundColor: colors.accent },
        !accent && { borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth },
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          { color: accent ? colors.accentText : colors.textPrimary },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    bottom: spacing.xl,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  readout: {
    flexShrink: 1,
  },
  km: {
    ...typography.titleSmall,
    fontVariant: ['tabular-nums'],
  },
  count: {
    ...typography.caption,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  button: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.full,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    ...typography.titleSmall,
  },
  disabled: {
    opacity: 0.4,
  },
  pressed: {
    opacity: 0.6,
  },

  modalBackdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  modalCard: {
    width: '100%',
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  modalTitle: {
    ...typography.titleLarge,
  },
  modalHint: {
    ...typography.bodySmall,
    fontVariant: ['tabular-nums'],
  },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.sm,
    padding: spacing.md,
    minHeight: 44,
    ...typography.body,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },
  modalButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.sm,
  },
  modalSave: {
    minWidth: 44,
    alignItems: 'center',
  },
  link: {
    ...typography.titleSmall,
  },
  saveText: {
    ...typography.titleSmall,
  },
});
