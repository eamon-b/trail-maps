/**
 * Free text with its web links made tappable — a waypoint description that
 * carries a URL (Shikoku's henro.org pages) opens it in the phone's browser.
 *
 * The links are nested `Text`, so they wrap with the prose around them. Only
 * the http(s) hrefs `@lib/text-links` hands back ever reach `Linking.openURL`.
 *
 * The text is selectable (long-press → copy), so a hut's phone number or an
 * inn's email address can be pasted into the dialler or a mail app.
 */

import { Linking, StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';
import { splitTextLinks } from '@lib/text-links';
import { useTheme } from '../../theme';

export function LinkifiedText({ text, style }: { text: string; style?: StyleProp<TextStyle> }) {
  const { colors } = useTheme();
  return (
    <Text selectable style={style}>
      {splitTextLinks(text).map((segment, i) =>
        segment.href ? (
          <Text
            key={i}
            accessibilityRole="link"
            onPress={() => void Linking.openURL(segment.href!)}
            style={[styles.link, { color: colors.accent }]}
          >
            {segment.text}
          </Text>
        ) : (
          segment.text
        ),
      )}
    </Text>
  );
}

const styles = StyleSheet.create({
  link: { textDecorationLine: 'underline' },
});
