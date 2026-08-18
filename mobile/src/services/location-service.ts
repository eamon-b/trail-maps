/**
 * Battery-aware GPS tracking service.
 *
 * Ported near-verbatim from the old app. Provides:
 *  - Two tracking profiles (standard 30 s / 10 m High, saver 120 s / 25 m
 *    Balanced) with an 'auto' preference that switches on battery level with
 *    30 % / 35 % hysteresis so a level hovering near the threshold can't flap.
 *  - A single shared foreground OS watch that fans out to every subscriber, so
 *    independent screens can track simultaneously without tearing each other's
 *    session down.
 *  - An OPT-IN background task (survives screen lock). It is never auto-started;
 *    a caller must explicitly request it — project policy is no always-on GPS.
 *
 * Permission results are compared against string literals ('granted'/'denied')
 * rather than the `Location.PermissionStatus` enum so the module behaves
 * identically under the real SDK and the lightweight test mock.
 */

import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as Battery from 'expo-battery';

// ---------------------------------------------------------------------------
// Tracking profiles (battery-aware tiers)
// ---------------------------------------------------------------------------

export type TrackingProfile = 'standard' | 'saver';

/** User preference: 'auto' resolves via battery level at start time. */
export type TrackingProfilePreference = 'auto' | TrackingProfile;

/** Battery fraction below which 'auto' selects the saver profile. */
export const AUTO_SAVER_BATTERY_THRESHOLD = 0.3;

/**
 * Battery fraction at/above which 'auto' returns from saver to standard. Higher
 * than the entry threshold so a level hovering around 30 % can't flap the
 * profile back and forth (hysteresis).
 */
export const AUTO_SAVER_EXIT_BATTERY_THRESHOLD = 0.35;

interface ProfileOptions {
  accuracy: Location.LocationAccuracy;
  timeInterval: number;
  distanceInterval: number;
}

export const TRACKING_PROFILES: Record<TrackingProfile, ProfileOptions> = {
  /** High accuracy, 30 s / 10 m cadence. */
  standard: {
    accuracy: Location.Accuracy.High,
    timeInterval: 30000,
    distanceInterval: 10,
  },
  /** Battery saver: balanced accuracy, 120 s / 25 m cadence. */
  saver: {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: 120000,
    distanceInterval: 25,
  },
};

let activeProfile: TrackingProfile = 'standard';

type ProfileChangeCallback = (profile: TrackingProfile) => void;
const profileChangeListeners = new Set<ProfileChangeCallback>();
let notifiedProfile: TrackingProfile = 'standard';

function notifyProfileChange(): void {
  if (notifiedProfile === activeProfile) return;
  notifiedProfile = activeProfile;
  for (const cb of profileChangeListeners) cb(activeProfile);
}

/** The profile the current/next tracking session runs with. */
export function getActiveTrackingProfile(): TrackingProfile {
  return activeProfile;
}

/** Alias for getActiveTrackingProfile (the profile the running session uses). */
export function getActiveProfile(): TrackingProfile {
  return activeProfile;
}

/**
 * Subscribe to active-profile changes (including auto battery auto-switches).
 * Returns an unsubscribe function.
 */
export function onProfileChange(callback: ProfileChangeCallback): () => void {
  profileChangeListeners.add(callback);
  return () => {
    profileChangeListeners.delete(callback);
  };
}

/**
 * Resolve a user preference to a concrete profile. 'auto' checks the battery
 * level (saver below AUTO_SAVER_BATTERY_THRESHOLD); a failed battery read falls
 * back to standard so tracking quality is never silently degraded.
 */
export async function resolveTrackingProfile(
  preference: TrackingProfilePreference,
): Promise<TrackingProfile> {
  if (preference === 'standard' || preference === 'saver') return preference;
  try {
    const level = await Battery.getBatteryLevelAsync();
    if (level >= 0 && level < AUTO_SAVER_BATTERY_THRESHOLD) return 'saver';
  } catch {
    // Battery info unavailable — prefer full tracking quality.
  }
  return 'standard';
}

export interface LocationUpdate {
  latitude: number;
  longitude: number;
  altitude: number | null;
  accuracy: number | null;
  /** Course-over-ground heading in degrees, valid while moving. */
  heading: number | null;
  /** Ground speed in m/s (gates whether `heading` can be trusted). */
  speed: number | null;
  timestamp: number;
}

export type PermissionStatus = 'granted' | 'denied' | 'undetermined';

function toPermissionStatus(status: string): PermissionStatus {
  if (status === 'granted') return 'granted';
  if (status === 'denied') return 'denied';
  return 'undetermined';
}

function toUpdate(loc: Location.LocationObject): LocationUpdate {
  return {
    latitude: loc.coords.latitude,
    longitude: loc.coords.longitude,
    altitude: loc.coords.altitude,
    accuracy: loc.coords.accuracy,
    heading: loc.coords.heading,
    speed: loc.coords.speed,
    timestamp: loc.timestamp,
  };
}

// Foreground tracking fans out to all subscribers over a single OS watch.
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
let backgroundActive = false;

// Define the background task at module level (required by Expo).
TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }) => {
  if (error) return;
  const { locations } = (data ?? {}) as { locations?: Location.LocationObject[] };
  if (!locations || locations.length === 0) return;
  for (const loc of locations) {
    const update = toUpdate(loc);
    for (const cb of backgroundSubscribers) cb(update);
  }
});

/** Request foreground location permission. */
export async function requestLocationPermission(): Promise<PermissionStatus> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  return toPermissionStatus(status);
}

/** Check current permission status without prompting. */
export async function getLocationPermissionStatus(): Promise<PermissionStatus> {
  const getter = Location.getForegroundPermissionsAsync;
  if (typeof getter !== 'function') return 'undetermined';
  const { status } = await getter();
  return toPermissionStatus(status);
}

/** Create the shared OS watch using the active tracking profile. */
function startWatch(): Promise<void> {
  subscriptionStarting = Location.watchPositionAsync(
    TRACKING_PROFILES[activeProfile],
    (location) => {
      const update = toUpdate(location);
      for (const cb of foregroundSubscribers) cb(update);
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
      // Clear the in-flight marker so the next start attempt can create a fresh
      // watch — a retained rejected promise would wedge tracking for the rest
      // of the app session.
      subscriptionStarting = null;
      throw err;
    },
  );
  return subscriptionStarting;
}

/**
 * Start continuous foreground location tracking. Multiple callers may subscribe;
 * the OS watch is created once and shared.
 */
export async function startLocationTracking(
  callback: ForegroundLocationCallback,
): Promise<void> {
  foregroundSubscribers.add(callback);
  if (!subscription && !subscriptionStarting) {
    startWatch();
  }
  await subscriptionStarting;
  reconcileAutoBattery();
}

/**
 * Switch the tracking profile. A live foreground watch and/or a running
 * background session both restart with the new cadence — subscribers keep
 * receiving updates uninterrupted. Restart failure reverts to the previous
 * profile so subscribers are never stranded without a watch.
 */
export async function setTrackingProfile(profile: TrackingProfile): Promise<void> {
  if (profile === activeProfile) return;
  const previous = activeProfile;
  activeProfile = profile;

  if (subscriptionStarting) {
    try {
      await subscriptionStarting;
    } catch {
      /* failed start — nothing to restart */
    }
  }

  let restartError: unknown = null;

  if (subscription && foregroundSubscribers.size > 0) {
    subscription.remove();
    subscription = null;
    try {
      await startWatch();
    } catch (err) {
      restartError = err;
      activeProfile = previous;
      try {
        await startWatch();
      } catch {
        // Restore failed too — leave state clean for the next start attempt.
      }
    }
  }

  if (backgroundActive && restartError == null) {
    try {
      await restartBackgroundWithActiveProfile();
    } catch (err) {
      restartError = err;
      activeProfile = previous;
      try {
        await restartBackgroundWithActiveProfile();
      } catch {
        backgroundActive = false;
      }
    }
  }

  notifyProfileChange();
  if (restartError) throw restartError;
}

/**
 * Stop continuous foreground tracking.
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
  reconcileAutoBattery();
}

/** Get a single location fix. */
export async function getCurrentPosition(): Promise<LocationUpdate> {
  const location = await Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.High,
  });
  return toUpdate(location);
}

// ---------------------------------------------------------------------------
// Background location API (opt-in only — never auto-started)
// ---------------------------------------------------------------------------

/** Request "always" (background) location permission. */
export async function requestBackgroundPermission(): Promise<PermissionStatus> {
  const { status } = await Location.requestBackgroundPermissionsAsync();
  return toPermissionStatus(status);
}

function startBackgroundUpdates(): Promise<void> {
  return Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
    ...TRACKING_PROFILES[activeProfile],
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'Tracknotes',
      notificationBody: 'Tracking your hike',
      notificationColor: '#2D6A4F',
    },
  }).then(() => {
    backgroundActive = true;
  });
}

async function restartBackgroundWithActiveProfile(): Promise<void> {
  const isRunning = await TaskManager.isTaskRegisteredAsync(BACKGROUND_LOCATION_TASK);
  if (isRunning) {
    await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  }
  await startBackgroundUpdates();
}

/**
 * Start background location updates (survives screen lock). OPT-IN — only a
 * caller that has requested background permission should ever invoke this.
 */
export async function startBackgroundTracking(): Promise<void> {
  await restartBackgroundWithActiveProfile();
  reconcileAutoBattery();
}

/** Stop background location updates. */
export async function stopBackgroundTracking(): Promise<void> {
  const isRunning = await TaskManager.isTaskRegisteredAsync(BACKGROUND_LOCATION_TASK);
  if (isRunning) {
    await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  }
  backgroundActive = false;
  backgroundSubscribers.clear();
  reconcileAutoBattery();
}

/** Subscribe to updates from the background task. Returns an unsubscribe fn. */
export function subscribeToBackgroundLocation(
  callback: BackgroundLocationCallback,
): () => void {
  backgroundSubscribers.add(callback);
  return () => {
    backgroundSubscribers.delete(callback);
  };
}

// ---------------------------------------------------------------------------
// Auto battery watcher (live profile switching with hysteresis)
// ---------------------------------------------------------------------------

let trackingPreference: TrackingProfilePreference = 'auto';
let batteryListener: Battery.Subscription | null = null;

/** True while any foreground or background session is (being) tracked. */
function trackingActive(): boolean {
  return (
    subscription != null ||
    subscriptionStarting != null ||
    foregroundSubscribers.size > 0 ||
    backgroundActive
  );
}

/** Apply the auto policy to a battery level (with hysteresis). */
function handleBatteryLevel(level: number): void {
  if (level < 0) return; // unknown — leave the current profile alone
  if (activeProfile === 'saver') {
    if (level >= AUTO_SAVER_EXIT_BATTERY_THRESHOLD) {
      setTrackingProfile('standard').catch(() => {});
    }
  } else if (level < AUTO_SAVER_BATTERY_THRESHOLD) {
    setTrackingProfile('saver').catch(() => {});
  }
}

function removeBatteryListener(): void {
  if (batteryListener) {
    batteryListener.remove();
    batteryListener = null;
  }
}

/**
 * Attach the battery listener exactly when it should be running (auto + a live
 * session) and detach it otherwise. Idempotent. Guarded against SDK/test
 * environments that do not expose the battery listener API.
 */
function reconcileAutoBattery(): void {
  const canListen = typeof Battery.addBatteryLevelListener === 'function';
  const shouldListen = canListen && trackingPreference === 'auto' && trackingActive();
  if (shouldListen && !batteryListener) {
    batteryListener = Battery.addBatteryLevelListener(({ batteryLevel }) => {
      handleBatteryLevel(batteryLevel);
    });
    // The listener only fires on change, so seed it with the current level.
    Battery.getBatteryLevelAsync().then(handleBatteryLevel).catch(() => {});
  } else if (!shouldListen && batteryListener) {
    removeBatteryListener();
  }
}

/**
 * Apply the user's tracking-profile preference. For 'standard'/'saver' this is
 * a fixed profile; for 'auto' it resolves the current battery level now and
 * keeps watching for the rest of the session.
 */
export async function setTrackingPreference(
  preference: TrackingProfilePreference,
): Promise<void> {
  trackingPreference = preference;
  const resolved = await resolveTrackingProfile(preference);
  await setTrackingProfile(resolved);
  reconcileAutoBattery();
}
