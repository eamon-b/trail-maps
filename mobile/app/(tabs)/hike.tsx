import { View, Text, StyleSheet } from 'react-native';

export default function HikeScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Hike Mode</Text>
      <Text style={styles.subtitle}>On-trail: map, GPS position, distance to next waypoint</Text>
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
    color: '#4CAF50',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
  },
});
