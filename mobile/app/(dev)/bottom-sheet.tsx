import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../src/theme';
import { AppBottomSheet } from '../../src/components';
import { spacing, touchTarget, radii } from '../../src/tokens/spacing';
import { typography } from '../../src/tokens/typography';

export default function BottomSheetScreen() {
  const { colors } = useTheme();
  const [isOpen, setIsOpen] = useState(false);
  const [snapIndex, setSnapIndex] = useState(1);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.buttons}>
        {[
          { label: 'Peek (25%)', snap: 0 },
          { label: 'Half (50%)', snap: 1 },
          { label: 'Full (90%)', snap: 2 },
        ].map(({ label, snap }) => (
          <Pressable
            key={snap}
            onPress={() => { setSnapIndex(snap); setIsOpen(true); }}
            style={[styles.button, { backgroundColor: colors.accent }]}
            accessibilityRole="button"
            accessibilityLabel={`Open bottom sheet at ${label}`}
          >
            <Text style={[styles.buttonText, { color: colors.textInverse }]}>{label}</Text>
          </Pressable>
        ))}
      </View>

      <AppBottomSheet
        isOpen={isOpen}
        onDismiss={() => setIsOpen(false)}
        initialSnap={snapIndex}
      >
        <Text style={[styles.sheetTitle, { color: colors.textPrimary }]}>
          Bottom Sheet Content
        </Text>
        <Text style={[styles.sheetBody, { color: colors.textSecondary }]}>
          This sheet has three snap points: peek (25%), half (50%), and full (90%).
          {'\n\n'}Drag the handle to move between snap points. Tap the backdrop or drag
          down past the peek position to dismiss.
          {'\n\n'}Content is scrollable within the sheet. The grabber handle is 36×5pt,
          rounded, and centered at the top.
        </Text>
      </AppBottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  buttons: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  button: {
    minHeight: touchTarget.min,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  buttonText: {
    ...typography.body,
    fontWeight: '600',
  },
  sheetTitle: {
    ...typography.displaySmall,
    marginBottom: spacing.md,
  },
  sheetBody: {
    ...typography.body,
    lineHeight: 24,
  },
});
