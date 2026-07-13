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

/**
 * Battery fraction at/above which 'auto' returns from saver to standard. Higher
 * than the entry threshold so a level hovering around 30% can't flap the
 * profile back and forth (hysteresis).
 */
export const AUTO_SAVER_EXIT_BATTERY_THRESHOLD = 0.35;

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

// Profile-change subscribers. The UI (hike status line) uses these so its
// disclosure always reflects the profile the GPS session is *really* running —
// including auto battery switches that happen while the screen is mounted.
type ProfileChangeCallback = (profile: TrackingProfile) => void;
const profileChangeListeners = new Set<ProfileChangeCallback>();
// Last value the listeners were told about, so notifyProfileChange() only
// fires on a net change (transient reverts during a failed restart collapse).
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
  /** Course-over-ground heading in degrees, valid while moving */
  heading: number | null;
  /** Ground speed in m/s (gates whether `heading` can be trusted) */
  speed: number | null;
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
// Whether a background location session is currently running. Tracked here
// (not derived from TaskManager) so setTrackingProfile can synchronously decide
// whether a background restart is needed.
let backgroundActive = false;

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
      speed: loc.coords.speed,
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
        speed: location.coords.speed,
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
  // A session is now running — engage the auto battery watcher if the user's
  // preference is 'auto'.
  reconcileAutoBattery();
}

/**
 * Switch the tracking profile. A live foreground watch and/or a running
 * background session both restart with the new cadence — subscribers keep
 * receiving updates uninterrupted.
 *
 * Restart failure is handled defensively: if the new-profile watch/task fails
 * to start, we restore the previous profile so subscribers are never stranded
 * without any watch. If that restore also fails, we leave subscribers
 * registered with no live watch and rethrow — the next startLocationTracking()
 * / app-foreground retry (see hike.tsx AppState listener) creates a fresh watch
 * (startWatch clears subscriptionStarting on rejection so it isn't wedged).
 */
export async function setTrackingProfile(profile: TrackingProfile): Promise<void> {
  if (profile === activeProfile) return;
  const previous = activeProfile;
  activeProfile = profile;

  // Wait out an in-flight start so we don't race the subscription slot.
  if (subscriptionStarting) {
    try { await subscriptionStarting; } catch { /* failed start — nothing to restart */ }
  }

  let restartError: unknown = null;

  // Restart a live foreground watch with the new cadence.
  if (subscription && foregroundSubscribers.size > 0) {
    subscription.remove();
    subscription = null;
    try {
      await startWatch();
    } catch (err) {
      restartError = err;
      // Restore a watch on the previous profile so subscribers keep getting
      // fixes rather than being stranded.
      activeProfile = previous;
      try {
        await startWatch();
      } catch {
        // Restore failed too — leave state clean for the next start attempt.
      }
    }
  }

  // Restart a running background session (it runs independently of the
  // foreground watch — see useLocation background mode — so a profile change
  // is a silent no-op there without this). Skipped if the foreground restart
  // already failed and reverted the profile.
  if (backgroundActive && restartError == null) {
    try {
      await restartBackgroundWithActiveProfile();
    } catch (err) {
      restartError = err;
      activeProfile = previous;
      try {
        await restartBackgroundWithActiveProfile();
      } catch {
        // Neither profile could restart the background task — mark it inactive
        // so a later startBackgroundTracking() re-registers it.
        backgroundActive = false;
      }
    }
  }

  notifyProfileChange();
  if (restartError) throw restartError;
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
  // Drop the auto battery watcher once nothing is tracking any more.
  reconcileAutoBattery();
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
    speed: location.coords.speed,
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

/**
 * Register the OS background updates with the active profile's cadence, keeping
 * the persistent-notification (foreground service) config. Does NOT touch the
 * subscriber set — used both for a fresh start and a profile restart.
 */
function startBackgroundUpdates(): Promise<void> {
  return Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
    ...TRACKING_PROFILES[activeProfile],
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: 'Trail Companion',
      notificationBody: 'Tracking your hike',
      notificationColor: '#4CAF50',
    },
  }).then(() => {
    backgroundActive = true;
  });
}

/**
 * Restart the background task with the current active profile without clearing
 * subscribers — a background session keeps fanning out to its subscribers
 * across a profile change.
 */
async function restartBackgroundWithActiveProfile(): Promise<void> {
  const isRunning = await TaskManager.isTaskRegisteredAsync(BACKGROUND_LOCATION_TASK);
  if (isRunning) {
    await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  }
  await startBackgroundUpdates();
}

/** Start background location updates (survives screen lock) */
export async function startBackgroundTracking(): Promise<void> {
  // Restart only the OS task. Do not call the public stop helper here: that
  // also clears the subscriber set, including the callback useLocation adds
  // immediately before starting the task.
  await restartBackgroundWithActiveProfile();
  // A background session is now running — engage the auto battery watcher if
  // the user's preference is 'auto'.
  reconcileAutoBattery();
}

/** Stop background location updates */
export async function stopBackgroundTracking(): Promise<void> {
  const isRunning = await TaskManager.isTaskRegisteredAsync(BACKGROUND_LOCATION_TASK);
  if (isRunning) {
    await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  }
  backgroundActive = false;
  backgroundSubscribers.clear();
  // Drop the auto battery watcher once nothing is tracking any more.
  reconcileAutoBattery();
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

// ---------------------------------------------------------------------------
// Auto battery watcher
//
// 'Auto' can't be a one-shot check at session start — the settings copy
// promises the saver "kicks in below 30%". While tracking is running AND the
// preference is 'auto', we watch the battery level and switch profiles live,
// with hysteresis (return to standard only above ~35%) so a level hovering
// near 30% doesn't flap the cadence back and forth.
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
 * session) and detach it otherwise. Idempotent — safe to call from any
 * start/stop/preference transition.
 */
function reconcileAutoBattery(): void {
  const shouldListen = trackingPreference === 'auto' && trackingActive();
  if (shouldListen && !batteryListener) {
    batteryListener = Battery.addBatteryLevelListener(({ batteryLevel }) => {
      handleBatteryLevel(batteryLevel);
    });
    // The listener only fires on change, so seed it with the current level —
    // a session that starts already-low must engage saver immediately.
    Battery.getBatteryLevelAsync().then(handleBatteryLevel).catch(() => {});
  } else if (!shouldListen && batteryListener) {
    removeBatteryListener();
  }
}

/**
 * Apply the user's tracking-profile preference. For 'standard'/'saver' this is
 * a fixed profile; for 'auto' it resolves the current battery level now and
 * keeps watching for the rest of the session. Prefer this over calling
 * resolveTrackingProfile + setTrackingProfile from the UI: it also owns the
 * auto battery listener lifecycle.
 */
export async function setTrackingPreference(
  preference: TrackingProfilePreference,
): Promise<void> {
  trackingPreference = preference;
  const resolved = await resolveTrackingProfile(preference);
  await setTrackingProfile(resolved);
  reconcileAutoBattery();
}
