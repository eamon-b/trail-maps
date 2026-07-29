import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../src/theme';
import { spacing, typography } from '../src/tokens';

export default function GuideListScreen() {
  const { colors } = useTheme();
  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Text style={[styles.title, { color: colors.textPrimary }]}>My Guides</Text>
      <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
        Guides will appear here.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  title: {
    ...typography.displayLarge,
  },
  subtitle: {
    ...typography.bodySmall,
  },
});
