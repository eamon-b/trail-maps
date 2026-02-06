import { useEffect, useState } from 'react';
import { View, Text, FlatList, StyleSheet, Pressable } from 'react-native';
import { TrailDataService, type Trail } from '../../src/services/trail-data-service';

export default function PlanScreen() {
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
    <View style={styles.container}>
      <Text style={styles.header}>Select a Trail</Text>
      <FlatList
        data={trails}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <Pressable style={styles.card}>
            <Text style={styles.trailName}>{item.name}</Text>
            <View style={styles.meta}>
              {item.region && <Text style={styles.region}>{item.region}</Text>}
              {item.lengthKm && <Text style={styles.length}>{item.lengthKm} km</Text>}
            </View>
          </Pressable>
        )}
        ListEmptyComponent={
          <Text style={styles.empty}>No trails loaded</Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  header: {
    fontSize: 18,
    fontWeight: '600',
    color: '#2196F3',
    padding: 16,
    paddingBottom: 8,
  },
  list: {
    padding: 16,
    paddingTop: 0,
    gap: 12,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
    elevation: 2,
  },
  trailName: {
    fontSize: 17,
    fontWeight: '600',
    color: '#333',
    marginBottom: 4,
  },
  meta: {
    flexDirection: 'row',
    gap: 12,
  },
  region: {
    fontSize: 14,
    color: '#666',
  },
  length: {
    fontSize: 14,
    color: '#2196F3',
    fontWeight: '500',
  },
  empty: {
    fontSize: 16,
    color: '#999',
    textAlign: 'center',
    marginTop: 40,
  },
});
