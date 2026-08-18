/**
 * Comment composer — note text, optional water-flow chip, one optional photo,
 * plus the inline display-name prompt for first-time posters.
 *
 * Posting is offline-first (`submitComment` writes to SQLite and enqueues), so
 * the only hard network dependency in this flow is registering the device the
 * very first time. That request CAN fail, and when it does the composer must
 * say so instead of silently swallowing a rejected promise: `finish()` catches
 * everything, keeps the draft (text / water status / photo) and the typed name,
 * and renders the failure inline. Retrying is then one tap.
 */

import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import type { WaterStatus } from '@lib/comments-api-types';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';
import { apiErrorMessage } from '../../api/error-message';
import {
  WATER_STATUS_OPTIONS,
  isWaterFamily,
  waterStatusMeta,
} from '../guide/waypoint-detail';
import {
  hasComposerContent,
  selectedPhotoFromResult,
  type SelectedPhoto,
} from './photo-upload';
import { MAX_DISPLAY_NAME_LENGTH, validateDisplayName } from './display-name';

/** Fallback copy when the failure isn't something we can be specific about. */
export const POST_FAILED_MESSAGE = "Couldn't post your comment. Please try again.";

/** Shown when the OS picker / camera throws (denied, cancelled mid-flight, …). */
export const PHOTO_FAILED_MESSAGE = "Couldn't attach that photo. Please try again.";

export interface ComposerSubmitArgs {
  text: string | null;
  waterStatus: WaterStatus | null;
  photo: SelectedPhoto | null;
  displayName?: string;
}

export function Composer({
  waypointType,
  registered,
  onSubmit,
}: {
  waypointType: string;
  registered: boolean;
  onSubmit: (args: ComposerSubmitArgs) => Promise<void>;
}) {
  const { colors } = useTheme();
  const showWater = isWaterFamily(waypointType);
  const [text, setText] = useState('');
  const [waterStatus, setWaterStatus] = useState<WaterStatus | null>(null);
  const [photo, setPhoto] = useState<SelectedPhoto | null>(null);
  const [busy, setBusy] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const hasContent = hasComposerContent({ text, waterStatus, photo });

  // Both picker flows are fire-and-forget from an onPress, so they own their
  // failures rather than leaving a rejected promise behind.
  const pickFromLibrary = useCallback(async () => {
    setError(null);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.7,
        allowsMultipleSelection: false,
        base64: false,
      });
      const selected = selectedPhotoFromResult(result);
      if (selected) setPhoto(selected);
    } catch {
      setError(PHOTO_FAILED_MESSAGE);
    }
  }, []);

  const takePhoto = useCallback(async () => {
    setError(null);
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) return;
      const result = await ImagePicker.launchCameraAsync({
        quality: 0.7,
        base64: false,
      });
      const selected = selectedPhotoFromResult(result);
      if (selected) setPhoto(selected);
    } catch {
      setError(PHOTO_FAILED_MESSAGE);
    }
  }, []);

  // Never rejects: a failed submit becomes inline error state with the draft
  // (and the typed display name) intact.
  const finish = useCallback(
    async (displayName?: string) => {
      setBusy(true);
      setError(null);
      try {
        await onSubmit({
          text: text.trim().length > 0 ? text.trim() : null,
          waterStatus,
          photo,
          displayName,
        });
        setText('');
        setWaterStatus(null);
        setPhoto(null);
        setPromptOpen(false);
      } catch (err) {
        // Keep `promptOpen` as-is so "Save & post" is the retry button.
        setError(apiErrorMessage(err, POST_FAILED_MESSAGE));
      } finally {
        setBusy(false);
      }
    },
    [onSubmit, text, waterStatus, photo],
  );

  const handleSubmit = useCallback(() => {
    if (!hasContent || busy) return;
    if (!registered) {
      setError(null);
      setPromptOpen(true);
      return;
    }
    void finish();
  }, [hasContent, busy, registered, finish]);

  const savePromptedName = useCallback(() => {
    if (busy) return;
    const check = validateDisplayName(nameDraft);
    if (!check.ok) {
      setError(check.message);
      return;
    }
    void finish(check.value);
  }, [busy, nameDraft, finish]);

  const errorText = error ? (
    <Text style={[styles.error, { color: colors.danger }]} accessibilityRole="alert">
      {error}
    </Text>
  ) : null;

  return (
    <View style={[styles.composer, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      {showWater && (
        <View style={styles.waterChips}>
          {WATER_STATUS_OPTIONS.map((status) => {
            const meta = waterStatusMeta(status);
            const color = colors[meta.colorToken];
            const active = waterStatus === status;
            return (
              <Pressable
                key={status}
                onPress={() => setWaterStatus(active ? null : status)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                style={[
                  styles.waterChip,
                  { borderColor: color },
                  active && { backgroundColor: color },
                ]}
              >
                <Text style={[styles.waterChipText, { color: active ? colors.textInverse : color }]}>
                  {meta.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}

      <TextInput
        style={[styles.input, { color: colors.textPrimary, borderColor: colors.border }]}
        placeholder={showWater ? 'Add a note or water report…' : 'Add a note…'}
        placeholderTextColor={colors.textSecondary}
        value={text}
        onChangeText={(next) => {
          setText(next);
          setError(null);
        }}
        multiline
        editable={!busy}
      />

      {photo ? (
        <View style={styles.photoChip}>
          <Image
            source={{ uri: photo.uri }}
            style={[styles.photoChipImage, { backgroundColor: colors.background }]}
            contentFit="cover"
            cachePolicy="disk"
            accessibilityIgnoresInvertColors
          />
          <Pressable
            onPress={() => setPhoto(null)}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Remove photo"
            hitSlop={spacing.sm}
            style={[styles.photoChipRemove, { backgroundColor: colors.scrim }]}
          >
            <Text style={[styles.photoChipRemoveIcon, { color: colors.textInverse }]}>×</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.photoActions}>
          <Pressable
            onPress={() => void pickFromLibrary()}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Add photo from library"
            hitSlop={spacing.xs}
            style={[styles.photoButton, { borderColor: colors.border }]}
          >
            <Text style={[styles.photoButtonIcon, { color: colors.accent }]}>🖼</Text>
            <Text style={[styles.photoButtonText, { color: colors.textSecondary }]}>Photo</Text>
          </Pressable>
          <Pressable
            onPress={() => void takePhoto()}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Take a photo"
            hitSlop={spacing.xs}
            style={[styles.photoButton, { borderColor: colors.border }]}
          >
            <Text style={[styles.photoButtonIcon, { color: colors.accent }]}>📷</Text>
            <Text style={[styles.photoButtonText, { color: colors.textSecondary }]}>Camera</Text>
          </Pressable>
        </View>
      )}

      {/* Inline failure surface. While the name prompt is open the same message
          is repeated inside the modal, which is what the user is looking at. */}
      {!promptOpen && errorText}

      <Pressable
        onPress={handleSubmit}
        disabled={!hasContent || busy}
        accessibilityRole="button"
        accessibilityLabel="Post comment"
        style={[
          styles.submit,
          { backgroundColor: hasContent && !busy ? colors.accent : colors.accentMuted },
        ]}
      >
        {busy ? (
          <ActivityIndicator color={colors.accentText} />
        ) : (
          <Text style={[styles.submitText, { color: colors.accentText }]}>Post</Text>
        )}
      </Pressable>

      <Modal
        visible={promptOpen}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!busy) setPromptOpen(false);
        }}
      >
        <View style={[styles.modalBackdrop, { backgroundColor: colors.scrim }]}>
          <View style={[styles.modalCard, { backgroundColor: colors.surfaceElevated }]}>
            <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>Choose a display name</Text>
            <Text style={[styles.modalHint, { color: colors.textSecondary }]}>
              Shown next to your comments. You can change it later in Settings.
            </Text>
            <TextInput
              style={[styles.input, { color: colors.textPrimary, borderColor: colors.border }]}
              placeholder="e.g. Trail Ghost"
              placeholderTextColor={colors.textSecondary}
              value={nameDraft}
              onChangeText={(next) => {
                setNameDraft(next);
                setError(null);
              }}
              autoFocus
              editable={!busy}
              maxLength={MAX_DISPLAY_NAME_LENGTH}
            />
            {errorText}
            <View style={styles.modalActions}>
              <Pressable
                onPress={() => setPromptOpen(false)}
                disabled={busy}
                accessibilityRole="button"
                style={styles.modalButton}
              >
                <Text style={[styles.actionLink, { color: colors.textSecondary }]}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={savePromptedName}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={error ? 'Retry posting comment' : 'Save display name and post'}
                style={[styles.modalButton, styles.modalSave, { backgroundColor: colors.accent }]}
              >
                {busy ? (
                  <ActivityIndicator color={colors.accentText} />
                ) : (
                  <Text style={[styles.submitText, { color: colors.accentText }]}>
                    {error ? 'Try again' : 'Save & post'}
                  </Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  composer: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  waterChips: { flexDirection: 'row', gap: spacing.sm },
  waterChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  waterChipText: { ...typography.dataSmall, fontWeight: '600' },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.sm,
    padding: spacing.md,
    minHeight: 64,
    ...typography.body,
    textAlignVertical: 'top',
  },
  error: { ...typography.bodySmall },

  photoActions: { flexDirection: 'row', gap: spacing.sm },
  photoButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  photoButtonIcon: { ...typography.dataSmall },
  photoButtonText: { ...typography.dataSmall, fontWeight: '600' },
  photoChip: { alignSelf: 'flex-start' },
  photoChipImage: { width: 88, height: 88, borderRadius: radii.md },
  photoChipRemove: {
    position: 'absolute',
    top: -spacing.xs,
    right: -spacing.xs,
    width: 24,
    height: 24,
    borderRadius: radii.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoChipRemoveIcon: { ...typography.titleSmall, lineHeight: 20 },

  submit: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.md,
    borderRadius: radii.sm,
    minHeight: 44,
  },
  submitText: { ...typography.titleSmall },
  actionLink: { ...typography.titleSmall },

  modalBackdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  modalCard: { width: '100%', borderRadius: radii.lg, padding: spacing.lg, gap: spacing.md },
  modalTitle: { ...typography.titleLarge },
  modalHint: { ...typography.bodySmall },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
  modalButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.sm,
  },
  modalSave: { minWidth: 44, alignItems: 'center' },
});
