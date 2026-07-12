import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet } from 'react-native';
import BottomSheet, {
  BottomSheetScrollView,
  BottomSheetBackdrop,
  BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, useBottomSheetDismiss } from '../theme';
import { useReduceMotion } from '../theme/useReduceMotion';
import { radii, spacing } from '../tokens/spacing';

interface AppBottomSheetProps {
  /** Whether the sheet is open */
  isOpen: boolean;
  /** Called when the sheet is dismissed */
  onDismiss: () => void;
  /** Content to display inside the sheet */
  children: React.ReactNode;
  /** Initial snap point index (0=peek, 1=half, 2=full). Default: 1 (half) */
  initialSnap?: number;
  /**
   * Snap points for the sheet. Defaults to the app-wide three-stop set
   * (peek 25% / half 50% / full 90%). Override for sheets that need a
   * different range (e.g. a form that opens larger).
   */
  snapPoints?: (string | number)[];
  /**
   * Passed straight through to the underlying gorhom BottomSheet. Left
   * undefined by default so existing consumers keep gorhom's default
   * behavior; set false when providing fixed snap points that should not be
   * augmented by a content-height snap point.
   */
  enableDynamicSizing?: boolean;
  /** Keyboard handling, passed through to the underlying BottomSheet. */
  keyboardBehavior?: 'extend' | 'fillParent' | 'interactive';
  keyboardBlurBehavior?: 'none' | 'restore';
  /** Forwarded to the inner scroll view (e.g. "handled" for forms). */
  keyboardShouldPersistTaps?: boolean | 'always' | 'never' | 'handled';
}

/** App-wide bottom sheet with three snap points: peek (25%), half (50%), full (90%) */
export function AppBottomSheet({
  isOpen,
  onDismiss,
  children,
  initialSnap = 1,
  snapPoints: snapPointsProp,
  enableDynamicSizing,
  keyboardBehavior,
  keyboardBlurBehavior,
  keyboardShouldPersistTaps,
}: AppBottomSheetProps) {
  const { colors, highContrast } = useTheme();
  const { registerSheet } = useBottomSheetDismiss();
  const reduceMotion = useReduceMotion();
  const insets = useSafeAreaInsets();
  const bottomSheetRef = useRef<BottomSheet>(null);

  // Register with BottomSheetContext so Android back button can dismiss
  useEffect(() => {
    if (isOpen) {
      return registerSheet(onDismiss);
    }
  }, [isOpen, registerSheet, onDismiss]);

  const defaultSnapPoints = useMemo(() => ['25%', '50%', '90%'], []);
  const snapPoints = snapPointsProp ?? defaultSnapPoints;

  const handleSheetChanges = useCallback(
    (index: number) => {
      if (index === -1) {
        onDismiss();
      }
    },
    [onDismiss],
  );

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        pressBehavior="close"
        opacity={0.5}
      />
    ),
    [],
  );

  if (!isOpen) return null;

  return (
    <BottomSheet
      ref={bottomSheetRef}
      index={initialSnap}
      snapPoints={snapPoints}
      enableDynamicSizing={enableDynamicSizing}
      onChange={handleSheetChanges}
      enablePanDownToClose
      backdropComponent={renderBackdrop}
      animateOnMount={!reduceMotion}
      keyboardBehavior={keyboardBehavior}
      keyboardBlurBehavior={keyboardBlurBehavior}
      handleIndicatorStyle={[
        styles.handleIndicator,
        { backgroundColor: highContrast ? colors.textPrimary : colors.textSecondary },
      ]}
      backgroundStyle={[
        styles.background,
        {
          // High contrast: solid background + a visible border, mirroring the
          // Card primitive so the sheet edge reads clearly against content.
          backgroundColor: highContrast ? colors.background : colors.surface,
          borderColor: colors.border,
          borderWidth: highContrast ? 1.5 : 0,
        },
      ]}
      style={styles.sheet}
    >
      <BottomSheetScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + spacing.lg },
        ]}
        keyboardShouldPersistTaps={keyboardShouldPersistTaps}
      >
        {children}
      </BottomSheetScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  sheet: {
    zIndex: 10,
  },
  background: {
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
  },
  handleIndicator: {
    width: 36,
    height: 5,
    borderRadius: 2.5,
  },
  content: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
});
