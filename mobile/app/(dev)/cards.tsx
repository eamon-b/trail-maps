import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../src/theme';
import { Card, StatDisplay, WaypointCard, type CardState } from '../../src/components';
import { spacing } from '../../src/tokens/spacing';
import { typography } from '../../src/tokens/typography';

const STATES: CardState[] = ['normal', 'loading', 'empty', 'degraded'];

export default function CardsScreen() {
  const { colors } = useTheme();

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.content}
    >
      <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>
        Generic Card — All States
      </Text>
      {STATES.map((state) => (
        <Card
          key={state}
          state={state}
          label={`CARD (${state})`}
          emptyMessage="No data available — tap to refresh"
          degradedMessage="Last known: 3 min ago"
        >
          {(state === 'normal' || state === 'degraded') && (
            <StatDisplay primary="12.4 km" secondary="+310m" />
          )}
        </Card>
      ))}

      <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>
        Waypoint Card — All States
      </Text>
      {STATES.map((state) => (
        <WaypointCard
          key={state}
          state={state}
          label={`NEXT CAMPSITE (${state})`}
          icon="⛺"
          name="Mumballup Camp"
          distance="12.4 km"
          elevation="+310m"
          degradedMessage="Last known: km 245 (no GPS)"
        />
      ))}

      <Text style={[styles.sectionHeader, { color: colors.textSecondary }]}>
        Compact Waypoint Cards (2-column)
      </Text>
      <View style={styles.gridRow}>
        <WaypointCard
          label="NEXT TOWN"
          icon="🏘️"
          name="Balingup"
          distance="34.7 km"
          elevation="+820m"
          compact
          style={styles.gridCard}
        />
        <WaypointCard
          label="NEXT SHELTER"
          icon="🛖"
          name="Harris Dam Hut"
          distance="8.2 km"
          compact
          style={styles.gridCard}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  sectionHeader: {
    ...typography.titleLarge,
    marginTop: spacing.xl,
    marginBottom: spacing.md,
  },
  gridRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  gridCard: {
    flex: 1,
  },
});
