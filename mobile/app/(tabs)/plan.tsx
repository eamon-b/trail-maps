import { useEffect, useState } from 'react';
import { View, Text, FlatList, StyleSheet, Pressable } from 'react-native';
import { useTheme } from '../../src/theme';
import { TrailDataService, type Trail } from '../../src/services/trail-data-service';
import { spacing, radii } from '../../src/tokens/spacing';
import { typography } from '../../src/tokens/typography';

export default function PlanScreen() {
  const { colors } = useTheme();
  const [trails, setTrails] = useState<Trail[]>([]);

  useEffect(() => {
    async function load() {
      const service = await TrailDataService.create();
      const list = await service.listTrails();
      setTrails(list);
    }
    load();
  }, []);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Text style={[styles.header, { color: colors.accent }]}>Select a Trail</Text>
      <FlatList
        data={trails}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <Pressable
            style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
            accessibilityRole="button"
            accessibilityLabel={`${item.name}${item.region ? `, ${item.region}` : ''}${item.lengthKm ? `, ${item.lengthKm} kilometers` : ''}`}
          >
            <Text style={[styles.trailName, { color: colors.textPrimary }]}>{item.name}</Text>
            <View style={styles.meta}>
              {item.region && <Text style={[styles.region, { color: colors.textSecondary }]}>{item.region}</Text>}
              {item.lengthKm && <Text style={[styles.length, { color: colors.accent }]}>{item.lengthKm} km</Text>}
            </View>
          </Pressable>
        )}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: colors.textSecondary }]}>No trails loaded</Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    ...typography.titleLarge,
    fontSize: 18,
    padding: spacing.lg,
    paddingBottom: spacing.sm,
  },
  list: {
    padding: spacing.lg,
    paddingTop: 0,
    gap: spacing.md,
  },
  card: {
    borderRadius: radii.lg,
    padding: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
    elevation: 2,
  },
  trailName: {
    ...typography.body,
    fontWeight: '600',
    marginBottom: spacing.xs,
  },
  meta: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  region: {
    ...typography.caption,
  },
  length: {
    ...typography.caption,
    fontWeight: '500',
  },
  empty: {
    ...typography.body,
    textAlign: 'center',
    marginTop: 40,
  },
});
