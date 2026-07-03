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
}

/** App-wide bottom sheet with three snap points: peek (25%), half (50%), full (90%) */
export function AppBottomSheet({
  isOpen,
  onDismiss,
  children,
  initialSnap = 1,
}: AppBottomSheetProps) {
  const { colors } = useTheme();
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

  const snapPoints = useMemo(() => ['25%', '50%', '90%'], []);

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
      onChange={handleSheetChanges}
      enablePanDownToClose
      backdropComponent={renderBackdrop}
      animateOnMount={!reduceMotion}
      handleIndicatorStyle={[styles.handleIndicator, { backgroundColor: colors.textSecondary }]}
      backgroundStyle={[styles.background, { backgroundColor: colors.surface }]}
      style={styles.sheet}
    >
      <BottomSheetScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + spacing.lg },
        ]}
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
