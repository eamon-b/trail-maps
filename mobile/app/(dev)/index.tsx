import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { router } from 'expo-router';
import { useTheme } from '../../src/theme';
import { spacing, radii, touchTarget } from '../../src/tokens/spacing';
import { typography } from '../../src/tokens/typography';

const CATALOG_ITEMS = [
  { route: '/(dev)/cards', title: 'Cards', description: 'Waypoint, stat, and generic cards in all states' },
  { route: '/(dev)/bottom-sheet', title: 'Bottom Sheet', description: 'Sheet snap points and content types' },
  { route: '/(dev)/mode-selector', title: 'Mode Selector', description: 'Expand/collapse, all three modes' },
  { route: '/(dev)/alerts', title: 'Alerts', description: 'Alert states, banners, and status bar' },
  { route: '/(dev)/day-plan-card', title: 'Day Plan Card', description: 'Gestures, swipe, drag' },
  { route: '/(dev)/typography', title: 'Typography', description: 'Full type scale at various sizes' },
  { route: '/(dev)/colors', title: 'Colors', description: 'All tokens across all four themes' },
  { route: '/(dev)/map-tiles', title: 'Map Tiles', description: 'Test MBTiles loading in MapLibre' },
] as const;

export default function DevCatalogIndex() {
  const { colors } = useTheme();

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.content}
    >
      <Text style={[styles.header, { color: colors.textSecondary }]}>
        Component Catalog (dev only)
      </Text>
      {CATALOG_ITEMS.map((item) => (
        <Pressable
          key={item.route}
          onPress={() => router.push(item.route)}
          style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
          accessibilityRole="button"
          accessibilityLabel={item.title}
        >
          <Text style={[styles.title, { color: colors.textPrimary }]}>{item.title}</Text>
          <Text style={[styles.description, { color: colors.textSecondary }]}>{item.description}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  header: {
    ...typography.titleLarge,
    marginBottom: spacing.sm,
  },
  card: {
    borderRadius: radii.lg,
    padding: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: touchTarget.min,
  },
  title: {
    ...typography.body,
    fontWeight: '600',
    marginBottom: spacing.xs,
  },
  description: {
    ...typography.caption,
  },
});
