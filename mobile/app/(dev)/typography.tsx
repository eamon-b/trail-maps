import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../src/theme';
import { typography, type TypographyToken } from '../../src/tokens/typography';
import { spacing } from '../../src/tokens/spacing';

const SAMPLES: { token: TypographyToken; text: string }[] = [
  { token: 'displayLarge', text: '12.4 km' },
  { token: 'displaySmall', text: '+310m  ~6h 30m' },
  { token: 'titleLarge', text: 'NEXT CAMPSITE' },
  { token: 'titleSmall', text: 'CARD LABEL' },
  { token: 'body', text: 'Mumballup Camp is a well-maintained campsite with tank water and a shelter.' },
  { token: 'caption', text: 'Updated 3 min ago · km 245' },
];

export default function TypographyScreen() {
  const { colors } = useTheme();

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.content}
    >
      {SAMPLES.map(({ token, text }) => (
        <View key={token} style={[styles.row, { borderBottomColor: colors.border }]}>
          <Text style={[styles.tokenLabel, { color: colors.textSecondary }]}>
            {token} — {typography[token].fontSize}pt
          </Text>
          <Text
            style={[typography[token] as any, { color: colors.textPrimary }]}
            allowFontScaling
          >
            {text}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  row: {
    paddingVertical: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tokenLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: spacing.sm,
  },
});
