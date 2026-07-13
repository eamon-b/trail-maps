import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { useTheme } from '../theme';
import { radii, spacing, touchTarget } from '../tokens/spacing';
import { glyphSizes, typography } from '../tokens/typography';
import { AppBottomSheet } from './AppBottomSheet';
import { CREATABLE_WAYPOINT_TYPES, getWaypointEmoji, getWaypointLabel } from '../lib/waypoint-type-meta';
import {
  pickWaypointPhoto,
  storeWaypointPhoto,
  deleteWaypointPhoto,
  type PhotoSource,
} from '../services/waypoint-photo-service';
import type { CustomWaypointType } from '../services/trail-data-service';

// Type chips offered by the form — the registry's creatable set.
const TYPE_OPTIONS: { type: CustomWaypointType; label: string }[] =
  CREATABLE_WAYPOINT_TYPES.map(type => ({ type, label: getWaypointLabel(type) }));

export interface AddWaypointValues {
  name: string;
  type: CustomWaypointType;
  description: string;
  /** Stored photo file URI, or null when no photo is attached */
  photoUri: string | null;
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
  initialValues?: { name: string; type: string; description?: string; photoUri?: string | null } | null;
  /** 'add' (default) shows Add copy; 'edit' shows Edit copy */
  mode?: 'add' | 'edit';
  /** Save is in flight — disables the Save button to prevent duplicate inserts */
  saving?: boolean;
  /** Edit mode: called when "Move pin" is tapped (enters crosshair mode) */
  onMovePin?: () => void;
}

/** Unique key for a stored photo file (URI, not name, is what's persisted). */
function generatePhotoKey(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Bottom sheet for creating or editing a custom waypoint (map long-press,
 * toolbar "+" crosshair, or "Mark my location"). Renders its form inside the
 * shared AppBottomSheet, opening larger (65% / 90%) with keyboard-aware
 * behavior for the text fields.
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
  onMovePin,
}: AddWaypointSheetProps) {
  const { colors } = useTheme();

  const [name, setName] = useState('');
  const [type, setType] = useState<CustomWaypointType>('water');
  const [description, setDescription] = useState('');
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  // Photo files created during this open session. Owned by the sheet until a
  // save hands the final one to the DB; the rest are deleted on close.
  const newPhotoUrisRef = useRef<string[]>([]);
  const savedRef = useRef(false);

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
      setPhotoUri(initialValues?.photoUri ?? null);
      newPhotoUrisRef.current = [];
      savedRef.current = false;
    }
    wasOpen.current = isOpen;
  }, [isOpen, initialValues]);

  const snapPoints = useMemo(() => ['65%', '90%'], []);

  const canSave = name.trim().length > 0 && !saving && !photoBusy;

  const handleSave = useCallback(() => {
    if (!canSave) return;
    savedRef.current = true;
    // Files picked then replaced/removed during this session are unreferenced.
    for (const uri of newPhotoUrisRef.current) {
      if (uri !== photoUri) deleteWaypointPhoto(uri);
    }
    newPhotoUrisRef.current = [];
    onSave({ name: name.trim(), type, description: description.trim(), photoUri });
  }, [canSave, onSave, name, type, description, photoUri]);

  // Wrap dismissal so photo files created this session but never saved are
  // cleaned up (AppBottomSheet also fires this after a programmatic close —
  // the savedRef/empty-list guards make it idempotent).
  const handleDismiss = useCallback(() => {
    if (!savedRef.current) {
      for (const uri of newPhotoUrisRef.current) {
        deleteWaypointPhoto(uri);
      }
      newPhotoUrisRef.current = [];
    }
    onDismiss();
  }, [onDismiss]);

  const addPhotoFrom = useCallback(async (source: PhotoSource) => {
    setPhotoBusy(true);
    try {
      const picked = await pickWaypointPhoto(source);
      if (picked) {
        const uri = await storeWaypointPhoto(generatePhotoKey(), picked);
        newPhotoUrisRef.current.push(uri);
        setPhotoUri(uri);
      }
    } catch (e) {
      console.warn('Failed to attach photo:', e);
      Alert.alert('Photo failed', 'Could not attach the photo. Please try again.');
    } finally {
      setPhotoBusy(false);
    }
  }, []);

  const handleAddPhoto = useCallback(() => {
    Alert.alert('Add photo', undefined, [
      { text: 'Take photo', onPress: () => { addPhotoFrom('camera'); } },
      { text: 'Choose from library', onPress: () => { addPhotoFrom('library'); } },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }, [addPhotoFrom]);

  const handleRemovePhoto = useCallback(() => {
    setPhotoUri(null);
  }, []);

  return (
    <AppBottomSheet
      isOpen={isOpen}
      onDismiss={handleDismiss}
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
              <Text style={styles.typeEmoji}>{getWaypointEmoji(option.type)}</Text>
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

      <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>Photo (optional)</Text>
      {photoBusy ? (
        <View style={styles.photoBusyRow}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={[styles.photoBusyText, { color: colors.textSecondary }]}>Processing photo…</Text>
        </View>
      ) : photoUri ? (
        <View style={styles.photoRow}>
          <Image
            source={{ uri: photoUri }}
            style={[styles.photoThumb, { borderColor: colors.border }]}
            accessibilityLabel="Waypoint photo"
          />
          <View style={styles.photoActions}>
            <Pressable
              onPress={handleAddPhoto}
              style={[styles.photoActionButton, { borderColor: colors.accent }]}
              accessibilityRole="button"
              accessibilityLabel="Replace photo"
            >
              <Text style={[styles.photoActionText, { color: colors.accent }]}>Replace</Text>
            </Pressable>
            <Pressable
              onPress={handleRemovePhoto}
              style={[styles.photoActionButton, { borderColor: colors.alertRed }]}
              accessibilityRole="button"
              accessibilityLabel="Remove photo"
            >
              <Text style={[styles.photoActionText, { color: colors.alertRed }]}>Remove</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable
          onPress={handleAddPhoto}
          style={[styles.addPhotoButton, { borderColor: colors.border }]}
          accessibilityRole="button"
          accessibilityLabel="Add photo"
        >
          <Text style={[styles.addPhotoText, { color: colors.accent }]}>📷  Add photo</Text>
        </Pressable>
      )}

      {mode === 'edit' && onMovePin && (
        <Pressable
          onPress={onMovePin}
          style={[styles.movePinButton, { borderColor: colors.accent }]}
          accessibilityRole="button"
          accessibilityLabel="Move pin on the map"
        >
          <Text style={[styles.movePinText, { color: colors.accent }]}>Move pin</Text>
        </Pressable>
      )}

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
        onPress={handleDismiss}
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
    fontSize: glyphSizes.sm,
  },
  typeLabel: {
    ...typography.caption,
    fontWeight: '600',
  },
  photoBusyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: touchTarget.min,
  },
  photoBusyText: {
    ...typography.caption,
  },
  photoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  photoThumb: {
    width: 72,
    height: 72,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  photoActions: {
    flex: 1,
    gap: spacing.sm,
  },
  photoActionButton: {
    borderWidth: 1,
    borderRadius: radii.md,
    minHeight: touchTarget.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoActionText: {
    ...typography.caption,
    fontWeight: '600',
  },
  addPhotoButton: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: radii.md,
    minHeight: touchTarget.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addPhotoText: {
    ...typography.body,
    fontWeight: '600',
  },
  movePinButton: {
    marginTop: spacing.md,
    borderWidth: 1,
    borderRadius: radii.md,
    minHeight: touchTarget.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  movePinText: {
    ...typography.body,
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
