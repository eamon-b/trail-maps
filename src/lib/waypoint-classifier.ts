/**
 * Waypoint Classification Module
 *
 * Classifies waypoints by type using multiple strategies:
 * 1. GeoJSON folder name (highest priority - explicit categorization)
 * 2. Known towns set (recognized town/resupply names)
 * 3. Prefix matching with required delimiters (fallback for GPX-only data)
 * 4. Default to 'waypoint' (lowest priority)
 */

export interface WaypointPrefixRule {
  prefix: string;
  type: string;
}

export interface ClassificationResult {
  type: string;
  cleanedName: string;
  matchedPrefix: string | null;
  source: 'folder' | 'known-town' | 'prefix' | 'default';
}

/**
 * GeoJSON folder name -> waypoint type mapping (case-insensitive)
 * Maps CalTopo/GeoJSON folder names to waypoint types
 */
export const FOLDER_TYPE_MAP: Record<string, string> = {
  // Campsites
  'campsites': 'campsite',
  'official campsites': 'campsite',
  'other campsites': 'campsite',
  // Huts/Shelters
  'huts': 'hut',
  'shelters': 'hut',
  'huts & shelters': 'hut',
  // Water
  'water': 'water',
  'water sources': 'water',
  'water tanks': 'water-tank',
  // Towns/Resupply
  'towns': 'town',
  'resupply': 'resupply',
  // Accommodation
  'accommodation': 'accommodation',
  // Transport/Access
  'trailheads': 'trailhead',
  'caravan parks': 'caravan-park',
  'major road crossings': 'road-crossing',
  // Features
  'side trips': 'side-trip',
  'mountains': 'mountain',
  'beaches': 'beach',
  // Food
  'extra food': 'food',
  'kiosks': 'food',
  // Points of Interest
  'places of interest': 'poi',
  'sights': 'poi',
  'inlets': 'poi',
  'other': 'poi',
};

/**
 * Prefix rules - ALL include delimiter (space or colon)
 * This prevents single letters from matching the start of unrelated words.
 *
 * Rules are ordered by prefix length (longer first) to ensure
 * more specific prefixes are matched before shorter ones.
 */
export const DEFAULT_PREFIX_RULES: WaypointPrefixRule[] = [
  // Multi-char prefixes (matched first)
  { prefix: 'WT:', type: 'water-tank' },
  { prefix: 'WT ', type: 'water-tank' },
  { prefix: 'ST:', type: 'side-trip' },
  { prefix: 'ST ', type: 'side-trip' },
  { prefix: 'TH:', type: 'trailhead' },
  { prefix: 'TH ', type: 'trailhead' },
  { prefix: 'CP:', type: 'caravan-park' },
  { prefix: 'CP ', type: 'caravan-park' },
  // Single-char prefixes - MUST have delimiter
  { prefix: 'C:', type: 'campsite' },
  { prefix: 'C ', type: 'campsite' },
  { prefix: 'W:', type: 'water' },
  { prefix: 'W ', type: 'water' },
  { prefix: 'H:', type: 'hut' },
  { prefix: 'H ', type: 'hut' },
  { prefix: 'R ', type: 'road-crossing' },
  { prefix: 'T:', type: 'town' },
  { prefix: 'T ', type: 'town' },
  { prefix: 'M:', type: 'mountain' },
  { prefix: 'M ', type: 'mountain' },
  { prefix: 'F:', type: 'food' },
  { prefix: 'F ', type: 'food' },
];

/**
 * Known town/resupply names (lowercase for case-insensitive matching)
 * Add more as needed for specific trails
 */
export const KNOWN_TOWNS = new Set([
  // AAWT towns
  'mt hotham',
  'adaminaby',
  'falls creek',
  'omeo',
  'thredbo',
  'glengarry',
  'rawson',
  'walhalla',
  'jindabyne',
  'khancoban',
  // Larapinta towns
  'alice springs',
  // Heysen towns
  'adelaide',
  'parachilna',
  'hawker',
  'quorn',
  'wilmington',
  'melrose',
  'burra',
  'kapunda',
  // Bibbulmun towns
  'kalamunda',
  'dwellingup',
  'collie',
  'balingup',
  'pemberton',
  'northcliffe',
  'walpole',
  'denmark',
  'albany',
]);

/**
 * Classify a waypoint by type.
 *
 * Classification priority:
 * 1. GeoJSON folder (if provided) - most reliable, explicit categorization
 * 2. KNOWN_TOWNS set - recognized town/resupply names
 * 3. Prefix matching (with required delimiters) - fallback for GPX-only data
 * 4. Default to 'waypoint'
 *
 * @param name - The waypoint name to classify
 * @param options - Optional classification options
 * @returns Classification result with type, cleaned name, and source
 */
export function classifyWaypoint(
  name: string,
  options?: {
    folderName?: string;
  }
): ClassificationResult {
  const trimmedName = name.trim();

  // Handle empty string
  if (!trimmedName) {
    return {
      type: 'waypoint',
      cleanedName: '',
      matchedPrefix: null,
      source: 'default',
    };
  }

  // Priority 1: GeoJSON folder (case-insensitive)
  if (options?.folderName) {
    const folderLower = options.folderName.toLowerCase();
    const folderType = FOLDER_TYPE_MAP[folderLower];
    if (folderType) {
      // Still need to clean the name if it has a prefix
      const { cleanedName, matchedPrefix } = cleanNameByPrefix(trimmedName);
      return {
        type: folderType,
        cleanedName,
        matchedPrefix,
        source: 'folder',
      };
    }
  }

  // Priority 2: Known towns (case-insensitive)
  const nameLower = trimmedName.toLowerCase();
  if (KNOWN_TOWNS.has(nameLower)) {
    return {
      type: 'town',
      cleanedName: trimmedName,
      matchedPrefix: null,
      source: 'known-town',
    };
  }

  // Priority 3: Prefix matching with required delimiters
  for (const rule of DEFAULT_PREFIX_RULES) {
    if (trimmedName.startsWith(rule.prefix)) {
      const cleanedName = trimmedName.slice(rule.prefix.length).trim();
      // Don't return empty name if prefix was the entire string
      if (cleanedName) {
        return {
          type: rule.type,
          cleanedName,
          matchedPrefix: rule.prefix,
          source: 'prefix',
        };
      }
    }
  }

  // Priority 4: Default
  return {
    type: 'waypoint',
    cleanedName: trimmedName,
    matchedPrefix: null,
    source: 'default',
  };
}

/**
 * Clean a waypoint name by removing any matching prefix.
 * Used when the type is already known (e.g., from folder) but name still has prefix.
 */
function cleanNameByPrefix(name: string): { cleanedName: string; matchedPrefix: string | null } {
  for (const rule of DEFAULT_PREFIX_RULES) {
    if (name.startsWith(rule.prefix)) {
      const cleaned = name.slice(rule.prefix.length).trim();
      if (cleaned) {
        return { cleanedName: cleaned, matchedPrefix: rule.prefix };
      }
    }
  }
  return { cleanedName: name, matchedPrefix: null };
}
