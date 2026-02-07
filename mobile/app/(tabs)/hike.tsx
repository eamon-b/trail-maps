import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../src/theme';
import { HikeDashboard, type DashboardData } from '../../src/components';

/** Mock data for dashboard development — will be replaced by real trail data in Part 2 */
const MOCK_DASHBOARD: DashboardData = {
  trailName: 'BIBBULMUN TRACK',
  direction: 'SOBO',
  currentKm: 245,
  totalKm: 982,

  nextCampsite: { name: 'Mumballup Camp', distance: '12.4 km', elevation: '+310m' },
  nextWater: { name: 'Murray River', distance: '3.1 km' },
  nextTown: { name: 'Balingup', distance: '34.7 km', elevation: '+820m' },
  nextShelter: { name: 'Harris Dam Hut', distance: '8.2 km' },

  today: {
    dayNumber: 12,
    totalDays: 42,
    startName: 'Murray Camp',
    endName: 'Mumballup Camp',
    distanceKm: 22.4,
    ascentM: 640,
    descentM: 520,
    estimatedHours: 6.5,
    completedKm: 10.0,
  },

  upcoming: [
    { id: '1', name: 'Murray River', type: 'water', distanceAhead: '3.1 km' },
    { id: '2', name: 'Road Crossing R412', type: 'road', distanceAhead: '5.8 km' },
    { id: '3', name: 'Mumballup Campsite', type: 'campsite', distanceAhead: '12.4 km' },
  ],
};

export default function HikeScreen() {
  const { colors } = useTheme();

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <HikeDashboard
        data={MOCK_DASHBOARD}
        state="normal"
        gpsState="normal"
        onSeeAllWaypoints={() => {}}
        onWaypointSelect={() => {}}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
