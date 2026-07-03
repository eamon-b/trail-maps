import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

export interface LocationUpdate {
  latitude: number;
  longitude: number;
  altitude: number | null;
  accuracy: number | null;
  heading: number | null;
  timestamp: number;
}

export type PermissionStatus = 'granted' | 'denied' | 'undetermined';

let subscription: Location.LocationSubscription | null = null;

// ---------------------------------------------------------------------------
// Background location task
// ---------------------------------------------------------------------------

export const BACKGROUND_LOCATION_TASK = 'background-location-task';

type BackgroundLocationCallback = (update: LocationUpdate) => void;
const backgroundSubscribers = new Set<BackgroundLocationCallback>();

// Define the background task at module level (required by Expo)
TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  if (error) return;
  const { locations } = data as { locations: Location.LocationObject[] };
  if (!locations || locations.length === 0) return;

  for (const loc of locations) {
    const update: LocationUpdate = {
      latitude: loc.coords.latitude,
      longitude: loc.coords.longitude,
      altitude: loc.coords.altitude,
      accuracy: loc.coords.accuracy,
      heading: loc.coords.heading,
      timestamp: loc.timestamp,
    };
    for (const cb of backgroundSubscribers) {
      cb(update);
    }
  }
});

/** Request foreground location permission */
export async function requestLocationPermission(): Promise<PermissionStatus> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status === Location.PermissionStatus.GRANTED) return 'granted';
  if (status === Location.PermissionStatus.DENIED) return 'denied';
  return 'undetermined';
}

/** Check current permission status without prompting */
export async function getLocationPermissionStatus(): Promise<PermissionStatus> {
  const { status } = await Location.getForegroundPermissionsAsync();
  if (status === Location.PermissionStatus.GRANTED) return 'granted';
  if (status === Location.PermissionStatus.DENIED) return 'denied';
  return 'undetermined';
}

/** Start continuous location tracking */
export async function startLocationTracking(
  callback: (location: LocationUpdate) => void,
): Promise<void> {
  await stopLocationTracking();

  subscription = await Location.watchPositionAsync(
    {
      accuracy: Location.Accuracy.High,
      timeInterval: 30000,
      distanceInterval: 10,
    },
    (location) => {
      callback({
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
        altitude: location.coords.altitude,
        accuracy: location.coords.accuracy,
        heading: location.coords.heading,
        timestamp: location.timestamp,
      });
    },
  );
}

/** Stop continuous location tracking */
export async function stopLocationTracking(): Promise<void> {
  if (subscription) {
    subscription.remove();
    subscription = null;
  }
}

/** Get a single location fix */
export async function getCurrentPosition(): Promise<LocationUpdate> {
  const location = await Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.High,
  });
  return {
    latitude: location.coords.latitude,
    longitude: location.coords.longitude,
    altitude: location.coords.altitude,
    accuracy: location.coords.accuracy,
    heading: location.coords.heading,
    timestamp: location.timestamp,
  };
}

// ---------------------------------------------------------------------------
// Background location API
// ---------------------------------------------------------------------------

/** Request "always" (background) location permission */
export async function requestBackgroundPermission(): Promise<PermissionStatus> {
  const { status } = await Location.requestBackgroundPermissionsAsync();
  if (status === Location.PermissionStatus.GRANTED) return 'granted';
  if (status === Location.PermissionStatus.DENIED) return 'denied';
  return 'undetermined';
}

/** Start background location updates (survives screen lock) */
export async function startBackgroundTracking(): Promise<void> {
  await stopBackgroundTracking();

  await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
    accuracy: Location.Accuracy.High,
    timeInterval: 30000,
    distanceInterval: 10,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'Trail Companion',
      notificationBody: 'Tracking your hike',
      notificationColor: '#4CAF50',
    },
  });
}

/** Stop background location updates */
export async function stopBackgroundTracking(): Promise<void> {
  const isRunning = await TaskManager.isTaskRegisteredAsync(BACKGROUND_LOCATION_TASK);
  if (isRunning) {
    await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  }
  backgroundSubscribers.clear();
}

/** Subscribe to location updates from the background task. Returns an unsubscribe function. */
export function subscribeToBackgroundLocation(
  callback: BackgroundLocationCallback,
): () => void {
  backgroundSubscribers.add(callback);
  return () => {
    backgroundSubscribers.delete(callback);
  };
}
