import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as Battery from 'expo-battery';

// ---------------------------------------------------------------------------
// Tracking profiles (battery-aware tiers — decision 8 of the P2 plan)
// ---------------------------------------------------------------------------

export type TrackingProfile = 'standard' | 'saver';

/** User preference: 'auto' resolves via battery level at start time */
export type TrackingProfilePreference = 'auto' | TrackingProfile;

/** Battery fraction below which 'auto' selects the saver profile */
export const AUTO_SAVER_BATTERY_THRESHOLD = 0.3;

interface ProfileOptions {
  accuracy: Location.LocationAccuracy;
  timeInterval: number;
  distanceInterval: number;
}

export const TRACKING_PROFILES: Record<TrackingProfile, ProfileOptions> = {
  /** Today's behavior: high accuracy, 30 s / 10 m cadence */
  standard: {
    accuracy: Location.Accuracy.High,
    timeInterval: 30000,
    distanceInterval: 10,
  },
  /** Battery saver: balanced accuracy, 120 s / 25 m cadence */
  saver: {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: 120000,
    distanceInterval: 25,
  },
};

let activeProfile: TrackingProfile = 'standard';

/** The profile the current/next tracking session runs with. */
export function getActiveTrackingProfile(): TrackingProfile {
  return activeProfile;
}

/**
 * Resolve a user preference to a concrete profile. 'auto' checks the battery
 * level (saver below AUTO_SAVER_BATTERY_THRESHOLD); a failed battery read
 * falls back to standard so tracking quality is never silently degraded.
 */
export async function resolveTrackingProfile(
  preference: TrackingProfilePreference,
): Promise<TrackingProfile> {
  if (preference === 'standard' || preference === 'saver') return preference;
  try {
    const level = await Battery.getBatteryLevelAsync();
    if (level >= 0 && level < AUTO_SAVER_BATTERY_THRESHOLD) return 'saver';
  } catch {
    // Battery info unavailable — prefer full tracking quality
  }
  return 'standard';
}

export interface LocationUpdate {
  latitude: number;
  longitude: number;
  altitude: number | null;
  accuracy: number | null;
  heading: number | null;
  timestamp: number;
}

export type PermissionStatus = 'granted' | 'denied' | 'undetermined';

// Foreground tracking fans out to all subscribers over a single OS watch, so
// independent screens (hike tab, map viewer) can track simultaneously and one
// screen unsubscribing never tears down another's updates.
type ForegroundLocationCallback = (update: LocationUpdate) => void;
const foregroundSubscribers = new Set<ForegroundLocationCallback>();
let subscription: Location.LocationSubscription | null = null;
let subscriptionStarting: Promise<void> | null = null;

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

/** Create the shared OS watch using the active tracking profile. */
function startWatch(): Promise<void> {
  subscriptionStarting = Location.watchPositionAsync(
    TRACKING_PROFILES[activeProfile],
    (location) => {
      const update: LocationUpdate = {
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
        altitude: location.coords.altitude,
        accuracy: location.coords.accuracy,
        heading: location.coords.heading,
        timestamp: location.timestamp,
      };
      for (const cb of foregroundSubscribers) {
        cb(update);
      }
    },
  ).then(
    (sub) => {
      subscription = sub;
      subscriptionStarting = null;
      // Everyone unsubscribed while the watch was starting — tear it down.
      if (foregroundSubscribers.size === 0) {
        sub.remove();
        subscription = null;
      }
    },
    (err) => {
      // Clear the in-flight marker so the next start attempt can create a
      // fresh watch — a retained rejected promise would wedge tracking for
      // the rest of the app session.
      subscriptionStarting = null;
      throw err;
    },
  );
  return subscriptionStarting;
}

/**
 * Start continuous location tracking. Multiple callers may subscribe; the OS
 * watch is created once and shared.
 */
export async function startLocationTracking(
  callback: ForegroundLocationCallback,
): Promise<void> {
  foregroundSubscribers.add(callback);

  if (!subscription && !subscriptionStarting) {
    startWatch();
  }

  await subscriptionStarting;
}

/**
 * Switch the tracking profile. If a foreground watch is live, it restarts
 * with the new cadence — subscribers keep receiving updates uninterrupted.
 */
export async function setTrackingProfile(profile: TrackingProfile): Promise<void> {
  if (profile === activeProfile) return;
  activeProfile = profile;

  // Wait out an in-flight start so we don't race the subscription slot.
  if (subscriptionStarting) {
    try { await subscriptionStarting; } catch { /* failed start — nothing to restart */ }
  }

  if (subscription && foregroundSubscribers.size > 0) {
    subscription.remove();
    subscription = null;
    await startWatch();
  }
}

/**
 * Stop continuous location tracking.
 * With a callback: unsubscribes only that caller; the OS watch stops once the
 * last subscriber is gone. Without a callback: stops everything.
 */
export async function stopLocationTracking(
  callback?: ForegroundLocationCallback,
): Promise<void> {
  if (callback) {
    foregroundSubscribers.delete(callback);
  } else {
    foregroundSubscribers.clear();
  }
  if (foregroundSubscribers.size === 0 && subscription) {
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
    ...TRACKING_PROFILES[activeProfile],
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
