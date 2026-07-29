import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../src/theme';
import { spacing, typography } from '../src/tokens';

export default function SettingsScreen() {
  const { colors } = useTheme();
  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
        Units, direction, and account settings will live here.
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
  subtitle: {
    ...typography.bodySmall,
    textAlign: 'center',
  },
});
