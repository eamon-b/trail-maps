import { useState, useCallback } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../src/theme';
import { DayPlanCard, UndoToast, type DayPlanData } from '../../src/components';
import { spacing } from '../../src/tokens/spacing';
import { typography } from '../../src/tokens/typography';

const MOCK_DAYS: DayPlanData[] = [
  {
    dayNumber: 1,
    date: 'Mar 15',
    startName: 'Kalamunda',
    endName: 'Mundaring Weir',
    distanceKm: 18.5,
    ascentM: 420,
    descentM: 380,
    estimatedHours: 5,
    waterSources: 3,
  },
  {
    dayNumber: 2,
    date: 'Mar 16',
    startName: 'Mundaring Weir',
    endName: 'Ball Creek Camp',
    distanceKm: 28.2,
    ascentM: 680,
    descentM: 720,
    estimatedHours: 8,
    waterSources: 1,
    warnings: ['Long day (>25 km)', 'Low water section'],
  },
  {
    dayNumber: 3,
    date: 'Mar 17',
    startName: 'Ball Creek Camp',
    endName: 'Brookton Camp',
    distanceKm: 21.0,
    ascentM: 310,
    descentM: 290,
    estimatedHours: 6,
    waterSources: 2,
  },
];

export default function DayPlanCardScreen() {
  const { colors } = useTheme();
  const [days, setDays] = useState(MOCK_DAYS);
  const [removedDay, setRemovedDay] = useState<{ data: DayPlanData; index: number } | null>(null);
  const [showUndo, setShowUndo] = useState(false);

  const handleRemove = useCallback((index: number) => {
    const removed = days[index];
    setRemovedDay({ data: removed, index });
    setDays((prev) => prev.filter((_, i) => i !== index));
    setShowUndo(true);
  }, [days]);

  const handleUndo = useCallback(() => {
    if (removedDay) {
      setDays((prev) => {
        const next = [...prev];
        next.splice(removedDay.index, 0, removedDay.data);
        return next;
      });
      setRemovedDay(null);
      setShowUndo(false);
    }
  }, [removedDay]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.hint, { color: colors.textSecondary }]}>
          Swipe left to remove a card. Tap ≡ ↑ ↓ for drag/merge/split actions.
        </Text>
        {days.map((day, index) => (
          <DayPlanCard
            key={`day-${day.dayNumber}`}
            data={day}
            onRemove={() => handleRemove(index)}
            onMergeUp={() => {}}
            onSplit={() => {}}
            onDragStart={() => {}}
          />
        ))}
        {days.length === 0 && (
          <Text style={[styles.empty, { color: colors.textSecondary }]}>
            All days removed. Tap Undo to restore.
          </Text>
        )}
      </ScrollView>
      <UndoToast
        visible={showUndo}
        message={removedDay ? `Day ${removedDay.data.dayNumber} removed` : ''}
        onUndo={handleUndo}
        onDismiss={() => setShowUndo(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  hint: {
    ...typography.caption,
    marginBottom: spacing.md,
  },
  empty: {
    ...typography.body,
    textAlign: 'center',
    marginTop: 40,
  },
});
