import { View, Text, StyleSheet } from 'react-native';

export default function ContributeScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Contribute Mode</Text>
      <Text style={styles.subtitle}>Report trail conditions, water sources, and waypoint updates</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#FF9800',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
  },
});
