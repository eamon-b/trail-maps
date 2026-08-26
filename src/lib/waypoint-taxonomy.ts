/**
 * Waypoint taxonomy — the single vocabulary of waypoint types and the
 * "families" the rest of the app reasons about.
 *
 * Waypoint `type` is a plain `string` throughout (`TrailWaypoint.type`), because
 * a GPX file may carry any `<type>` text and we preserve it verbatim rather than
 * flattening it into our own vocabulary. This module is therefore *descriptive*,
 * not a gate: `WAYPOINT_TYPES` is what our own classifier emits, and the family
 * predicates below additionally accept the common aliases real-world GPX files
 * use so an imported `spring` still counts as water and an imported `supermarket`
 * still counts as a resupply.
 *
 * Before this module the water rule lived in three places
 * (`water-carry-calculator`, `day-calculator`, and the mobile list pane) and the
 * resupply rule in two. Adding a type meant remembering all of them. Import from
 * here instead.
 */

/**
 * Every type our own classifier can produce, in a sensible display order.
 *
 * Note this is *not* an exhaustive list of types you will encounter — an
 * imported GPX can name anything. Treat an unlisted type as valid-but-unknown
 * (see `isKnownWaypointType`).
 */
export const WAYPOINT_TYPES = [
  'campsite',
  'hut',
  'water',
  'water-tank',
  'town',
  'resupply',
  'food',
  'accommodation',
  'caravan-park',
  'trailhead',
  'road-crossing',
  'inlet-crossing',
  'side-trip',
  'mountain',
  'beach',
  'endpoint',
  'poi',
  'waypoint',
] as const;

/** A type our classifier can emit. Not a constraint on stored data. */
export type WaypointType = (typeof WAYPOINT_TYPES)[number];

/** Human-readable labels for the canonical types (for filter menus, selects). */
export const WAYPOINT_TYPE_LABELS: Record<WaypointType, string> = {
  campsite: 'Campsite',
  hut: 'Hut / shelter',
  water: 'Water source',
  'water-tank': 'Water tank',
  town: 'Town',
  resupply: 'Resupply',
  food: 'Food',
  accommodation: 'Accommodation',
  'caravan-park': 'Caravan park',
  trailhead: 'Trailhead',
  'road-crossing': 'Road crossing',
  'inlet-crossing': 'Inlet crossing',
  'side-trip': 'Side trip',
  mountain: 'Mountain',
  beach: 'Beach',
  endpoint: 'Start / end',
  poi: 'Point of interest',
  waypoint: 'Unclassified',
};

const KNOWN_TYPES: ReadonlySet<string> = new Set<string>(WAYPOINT_TYPES);

/** True when `type` is one of the types our classifier produces. */
export function isKnownWaypointType(type: string | undefined | null): type is WaypointType {
  return typeof type === 'string' && KNOWN_TYPES.has(type);
}

/**
 * Display label for any type string: the curated label for a canonical type,
 * otherwise the raw slug prettified (`fire-trail` → `Fire trail`) so an
 * imported GPX's own vocabulary still reads properly.
 */
export function waypointTypeLabel(type: string | undefined | null): string {
  if (!type) return WAYPOINT_TYPE_LABELS.waypoint;
  if (isKnownWaypointType(type)) return WAYPOINT_TYPE_LABELS[type];
  const words = type.replace(/[_-]+/g, ' ').trim();
  if (!words) return WAYPOINT_TYPE_LABELS.waypoint;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Canonical water types — what our classifier emits for a water source.
 *
 * `water-tank` is kept distinct from `water` because a tank is a built,
 * usually-reliable store while a `water` point may be a creek.
 */
export const WATER_TYPES: ReadonlySet<string> = new Set(['water', 'water-tank']);

/**
 * Type strings from *other* people's GPX files that mean "you can get water
 * here". Used only by `isWaterWaypoint`, never emitted by us.
 */
export const WATER_TYPE_ALIASES: ReadonlySet<string> = new Set([
  'spring',
  'creek',
  'stream',
  'river',
  'tap',
  'tank',
  'rainwater',
  'water-source',
  'watersource',
  'waterhole',
  'well',
  'soak',
  'bore',
  'trough',
]);

/**
 * Canonical types at which a hiker can obtain food supplies.
 *
 * `accommodation` and `caravan-park` are deliberately excluded — they are
 * shelter, and do not reliably mean food can be obtained.
 */
export const RESUPPLY_TYPES: ReadonlySet<string> = new Set(['town', 'food', 'resupply']);

/**
 * Type strings from *other* people's GPX files that mean "you can get food
 * here". Used only by `isResupplyWaypoint`, never emitted by us.
 */
export const RESUPPLY_TYPE_ALIASES: ReadonlySet<string> = new Set([
  'store',
  'shop',
  'supermarket',
  'grocery',
  'groceries',
  'kiosk',
  'cafe',
  'restaurant',
  'post-office',
  'postoffice',
  'roadhouse',
  'village',
  'settlement',
]);

function inFamily(
  type: string | undefined | null,
  canonical: ReadonlySet<string>,
  aliases: ReadonlySet<string>,
): boolean {
  if (typeof type !== 'string') return false;
  const key = type.trim().toLowerCase();
  if (!key) return false;
  return canonical.has(key) || aliases.has(key);
}

/** True when water can be collected at a waypoint of this type. */
export function isWaterWaypoint(type: string | undefined | null): boolean {
  return inFamily(type, WATER_TYPES, WATER_TYPE_ALIASES);
}

/** True when food supplies can be obtained at a waypoint of this type. */
export function isResupplyWaypoint(type: string | undefined | null): boolean {
  return inFamily(type, RESUPPLY_TYPES, RESUPPLY_TYPE_ALIASES);
}

/**
 * The waypoint families the datasheet filter offers.
 *
 * `all` is not listed here — it is the absence of a filter and needs no
 * predicate.
 */
export const WAYPOINT_FAMILIES = ['water', 'resupply'] as const;

/** A filterable waypoint family (excluding the implicit "all"). */
export type WaypointFamily = (typeof WAYPOINT_FAMILIES)[number];

/** True when a waypoint of this type belongs to `family`. */
export function matchesWaypointFamily(
  type: string | undefined | null,
  family: WaypointFamily,
): boolean {
  return family === 'water' ? isWaterWaypoint(type) : isResupplyWaypoint(type);
}
