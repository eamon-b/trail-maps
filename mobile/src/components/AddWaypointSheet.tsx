import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { useTheme } from '../theme';
import { radii, spacing, touchTarget } from '../tokens/spacing';
import { typography } from '../tokens/typography';
import { AppBottomSheet } from './AppBottomSheet';
import { waypointEmojis } from './WaypointList';
import type { CustomWaypointType } from '../services/trail-data-service';

const TYPE_OPTIONS: { type: CustomWaypointType; label: string }[] = [
  { type: 'water', label: 'Water' },
  { type: 'water-tank', label: 'Water tank' },
  { type: 'campsite', label: 'Campsite' },
  { type: 'poi', label: 'Point of interest' },
];

export interface AddWaypointValues {
  name: string;
  type: CustomWaypointType;
  description: string;
}

interface AddWaypointSheetProps {
  /** Whether the sheet is open */
  isOpen: boolean;
  /** Called when the sheet is dismissed without saving */
  onDismiss: () => void;
  /** Called with the entered values when Save is tapped */
  onSave: (values: AddWaypointValues) => void;
  /** km along the trail (active direction) where the waypoint sits */
  kmPosition: number | null;
  /** Metres from the pressed location to the trail, or null when unknown */
  offTrackM?: number | null;
  /** Prefill values when editing an existing custom waypoint */
  initialValues?: { name: string; type: string; description?: string } | null;
  /** 'add' (default) shows Add copy; 'edit' shows Edit copy */
  mode?: 'add' | 'edit';
  /** Save is in flight — disables the Save button to prevent duplicate inserts */
  saving?: boolean;
}

/**
 * Bottom sheet for creating or editing a custom waypoint (long-press on the
 * trail map). Renders its form inside the shared AppBottomSheet, opening larger
 * (65% / 90%) with keyboard-aware behavior for the text fields.
 */
export function AddWaypointSheet({
  isOpen,
  onDismiss,
  onSave,
  kmPosition,
  offTrackM,
  initialValues,
  mode = 'add',
  saving = false,
}: AddWaypointSheetProps) {
  const { colors } = useTheme();

  const [name, setName] = useState('');
  const [type, setType] = useState<CustomWaypointType>('water');
  const [description, setDescription] = useState('');

  // (Re)seed the form on the closed → open transition only. Parents may
  // recreate the initialValues object every render, and reseeding while open
  // would wipe in-progress typing.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      setName(initialValues?.name ?? '');
      const initialType = TYPE_OPTIONS.find(o => o.type === initialValues?.type)?.type ?? 'water';
      setType(initialType);
      setDescription(initialValues?.description ?? '');
    }
    wasOpen.current = isOpen;
  }, [isOpen, initialValues]);

  const snapPoints = useMemo(() => ['65%', '90%'], []);

  const canSave = name.trim().length > 0 && !saving;

  const handleSave = useCallback(() => {
    if (!canSave) return;
    onSave({ name: name.trim(), type, description: description.trim() });
  }, [canSave, onSave, name, type, description]);

  return (
    <AppBottomSheet
      isOpen={isOpen}
      onDismiss={onDismiss}
      snapPoints={snapPoints}
      initialSnap={0}
      enableDynamicSizing={false}
      keyboardBehavior="extend"
      keyboardBlurBehavior="restore"
      keyboardShouldPersistTaps="handled"
    >
      <Text style={[styles.title, { color: colors.textPrimary }]}>
        {mode === 'edit' ? 'Edit Waypoint' : 'Add Waypoint'}
      </Text>

      {kmPosition != null && (
        <Text style={[styles.positionLine, { color: colors.textSecondary }]}>
          km {kmPosition.toFixed(1)}
          {offTrackM != null ? ` · ≈${Math.round(offTrackM)} m off trail` : ''}
        </Text>
      )}

      <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Name</Text>
      <BottomSheetTextInput
        value={name}
        onChangeText={setName}
        placeholder="Waypoint name"
        placeholderTextColor={colors.textSecondary}
        accessibilityLabel="Waypoint name"
        style={[
          styles.input,
          { backgroundColor: colors.background, borderColor: colors.border, color: colors.textPrimary },
        ]}
      />

      <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Type</Text>
      <View style={styles.typeRow}>
        {TYPE_OPTIONS.map(option => {
          const selected = option.type === type;
          return (
            <Pressable
              key={option.type}
              onPress={() => setType(option.type)}
              style={[
                styles.typeChip,
                {
                  backgroundColor: selected ? colors.accentSubtle : colors.background,
                  borderColor: selected ? colors.accent : colors.border,
                },
              ]}
              accessibilityRole="button"
              accessibilityLabel={option.label}
              accessibilityState={{ selected }}
            >
              <Text style={styles.typeEmoji}>{waypointEmojis[option.type] ?? waypointEmojis.poi}</Text>
              <Text
                style={[
                  styles.typeLabel,
                  { color: selected ? colors.accent : colors.textPrimary },
                ]}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Notes (optional)</Text>
      <BottomSheetTextInput
        value={description}
        onChangeText={setDescription}
        placeholder="e.g. Reliable year round, 100 m down side track"
        placeholderTextColor={colors.textSecondary}
        accessibilityLabel="Waypoint notes"
        multiline
        style={[
          styles.input,
          styles.notesInput,
          { backgroundColor: colors.background, borderColor: colors.border, color: colors.textPrimary },
        ]}
      />

      <Pressable
        onPress={handleSave}
        disabled={!canSave}
        style={[
          styles.saveButton,
          { backgroundColor: canSave ? colors.accent : colors.border },
        ]}
        accessibilityRole="button"
        accessibilityLabel="Save waypoint"
        accessibilityState={{ disabled: !canSave }}
      >
        <Text style={[styles.saveButtonText, { color: canSave ? colors.textInverse : colors.textSecondary }]}>
          Save
        </Text>
      </Pressable>

      <Pressable
        onPress={onDismiss}
        style={styles.cancelButton}
        accessibilityRole="button"
        accessibilityLabel="Cancel"
      >
        <Text style={[styles.cancelButtonText, { color: colors.textSecondary }]}>Cancel</Text>
      </Pressable>
    </AppBottomSheet>
  );
}

const styles = StyleSheet.create({
  title: {
    ...typography.titleLarge,
    marginBottom: spacing.xs,
  },
  positionLine: {
    ...typography.caption,
    fontVariant: ['tabular-nums'],
    marginBottom: spacing.md,
  },
  fieldLabel: {
    ...typography.caption,
    fontWeight: '600',
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  input: {
    ...typography.body,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: touchTarget.min,
  },
  notesInput: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
  typeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  typeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderWidth: 1,
    borderRadius: radii.full,
    paddingHorizontal: spacing.md,
    minHeight: touchTarget.min,
  },
  typeEmoji: {
    fontSize: 16,
  },
  typeLabel: {
    ...typography.caption,
    fontWeight: '600',
  },
  saveButton: {
    marginTop: spacing.xl,
    borderRadius: radii.lg,
    minHeight: touchTarget.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveButtonText: {
    ...typography.body,
    fontWeight: '700',
  },
  cancelButton: {
    marginTop: spacing.sm,
    minHeight: touchTarget.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelButtonText: {
    ...typography.body,
    fontWeight: '600',
  },
});
