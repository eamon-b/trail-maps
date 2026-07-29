import { StyleSheet, Text, View } from 'react-native';

export default function GuideListScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>My Guides</Text>
      <Text style={styles.subtitle}>Guides will appear here.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
  },
  subtitle: {
    fontSize: 14,
    opacity: 0.6,
  },
});
