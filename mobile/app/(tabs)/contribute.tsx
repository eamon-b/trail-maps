import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '../../src/theme';
import { typography } from '../../src/tokens/typography';
import { spacing } from '../../src/tokens/spacing';

export default function ContributeScreen() {
  const { colors } = useTheme();

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Text style={[styles.title, { color: colors.accent }]}>Contribute Mode</Text>
      <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
        Report trail conditions, water sources, and waypoint updates
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  title: {
    ...typography.displayLarge,
    marginBottom: spacing.sm,
  },
  subtitle: {
    ...typography.body,
    textAlign: 'center',
  },
});
