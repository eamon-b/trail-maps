/**
 * Single registry for waypoint-type presentation metadata.
 *
 * Waypoint types were previously duplicated across four hardcoded lists
 * (AddWaypointSheet TYPE_OPTIONS, TrailMap WAYPOINT_COLORS, WaypointList
 * waypointEmojis, datasheet TYPE_LABELS) that silently disagreed. This module
 * is the one source of truth: label, emoji, marker color, and whether the
 * type is offered in the Add Waypoint form (`creatable`).
 *
 * Colors are literal hex because they feed MapLibre/Skia marker styles that
 * render on top of imagery, not themed UI surfaces (same rationale as the
 * trail line colors in TrailMap).
 *
 * NOTE for calculators: water/resupply analysis uses explicit allow-lists
 * (`water`/`water-tank` in @lib/day-calculator + water-carry-calculator,
 * `town`/`food` in resupply-calculator). Adding a type here does NOT feed it
 * into those calculators — `hazard`, `lookout`, and `junction` are
 * intentionally excluded from water and resupply math.
 */

export interface WaypointTypeMeta {
  /** The stored `type` string */
  type: string;
  /** Human-readable label ("Water tank") */
  label: string;
  /** Emoji used in lists, sheets, and chips */
  emoji: string;
  /** Marker color on the map and elevation profile */
  color: string;
  /** Whether the Add Waypoint form offers this type */
  creatable: boolean;
}

const META: WaypointTypeMeta[] = [
  // --- Creatable set (decision 3 in plans/usability-p1-field-features.md) ---
  { type: 'water', label: 'Water', emoji: '💧', color: '#2196F3', creatable: true },
  { type: 'water-tank', label: 'Water tank', emoji: '🚰', color: '#2196F3', creatable: true },
  { type: 'campsite', label: 'Campsite', emoji: '⛺', color: '#4CAF50', creatable: true },
  { type: 'shelter', label: 'Shelter', emoji: '🏚️', color: '#795548', creatable: true },
  { type: 'town', label: 'Town', emoji: '🏘️', color: '#FF9800', creatable: true },
  { type: 'lookout', label: 'Lookout', emoji: '👁️', color: '#607D8B', creatable: true },
  { type: 'junction', label: 'Junction', emoji: '🔀', color: '#757575', creatable: true },
  // Alert-amber family: must read as a warning on the map, distinct from the
  // blue/green resource markers.
  { type: 'hazard', label: 'Hazard', emoji: '⚠️', color: '#FF8F00', creatable: true },
  { type: 'poi', label: 'Point of interest', emoji: '📍', color: '#FFC107', creatable: true },

  // --- Bundled-data / classifier types (display only) ---
  { type: 'hut', label: 'Hut', emoji: '🛖', color: '#795548', creatable: false },
  { type: 'accommodation', label: 'Accommodation', emoji: '🛖', color: '#795548', creatable: false },
  { type: 'caravan-park', label: 'Caravan park', emoji: '🛖', color: '#795548', creatable: false },
  { type: 'mountain', label: 'Mountain', emoji: '⛰️', color: '#607D8B', creatable: false },
  { type: 'summit', label: 'Summit', emoji: '⛰️', color: '#607D8B', creatable: false },
  { type: 'trailhead', label: 'Trailhead', emoji: '🥾', color: '#9C27B0', creatable: false },
  { type: 'endpoint', label: 'Endpoint', emoji: '🥾', color: '#9C27B0', creatable: false },
  { type: 'food', label: 'Food', emoji: '🍽️', color: '#FF5722', creatable: false },
  { type: 'resupply', label: 'Resupply', emoji: '🛒', color: '#FF5722', creatable: false },
  { type: 'road', label: 'Road crossing', emoji: '🛣️', color: '#757575', creatable: false },
  { type: 'road-crossing', label: 'Road crossing', emoji: '🛣️', color: '#757575', creatable: false },
  { type: 'inlet-crossing', label: 'Inlet crossing', emoji: '🌉', color: '#00BCD4', creatable: false },
  { type: 'beach', label: 'Beach', emoji: '🏖️', color: '#00BCD4', creatable: false },
  { type: 'bridge', label: 'Bridge', emoji: '🌉', color: '#757575', creatable: false },
  { type: 'carpark', label: 'Car park', emoji: '🅿️', color: '#757575', creatable: false },
  { type: 'information', label: 'Information', emoji: 'ℹ️', color: '#757575', creatable: false },
  { type: 'danger', label: 'Danger', emoji: '⚠️', color: '#FF8F00', creatable: false },
  { type: 'side-trip', label: 'Side trip', emoji: '📍', color: '#9C27B0', creatable: false },
];

/** Registry keyed by type string. */
export const WAYPOINT_TYPE_META: Record<string, WaypointTypeMeta> = Object.fromEntries(
  META.map(m => [m.type, m]),
);

/** Types offered by the Add Waypoint form, in display order. */
export const CREATABLE_WAYPOINT_TYPES: string[] = META.filter(m => m.creatable).map(m => m.type);

const FALLBACK_COLOR = '#757575';
const FALLBACK_EMOJI = '📍';

/** Marker color for a waypoint type (gray fallback for unknown types). */
export function getWaypointColor(type: string): string {
  return WAYPOINT_TYPE_META[type]?.color ?? FALLBACK_COLOR;
}

/** Emoji for a waypoint type (pin fallback for unknown types). */
export function getWaypointEmoji(type: string): string {
  return WAYPOINT_TYPE_META[type]?.emoji ?? FALLBACK_EMOJI;
}

/** Human-readable label for a waypoint type (capitalized fallback). */
export function getWaypointLabel(type: string): string {
  const meta = WAYPOINT_TYPE_META[type];
  if (meta) return meta.label;
  return type.length > 0 ? type.charAt(0).toUpperCase() + type.slice(1) : type;
}
