/**
 * Waypoint Classification Module
 *
 * Classifies waypoints by type using multiple strategies:
 * 1. GeoJSON folder name (highest priority - explicit categorization)
 * 2. Known towns set (recognized town/resupply names)
 * 3. Prefix matching with required delimiters (fallback for GPX-only data)
 * 4. Keyword inference anywhere in the name (opt-in — see `inferFromKeywords`)
 * 5. Default to 'waypoint' (lowest priority)
 *
 * Tier 4 is opt-in because the two producers of waypoints want opposite things:
 * curated trails carry CalTopo folders and hand-written `C:`/`WT:` prefixes, so
 * guessing from words would only add noise (and churn the pinned generated
 * JSON), whereas a user's own GPX file follows no convention at all and would
 * otherwise land every waypoint on 'waypoint'.
 */

export interface WaypointPrefixRule {
  prefix: string;
  type: string;
}

/** One keyword-inference rule: any of `keywords` present ⇒ `type`. */
export interface WaypointKeywordRule {
  /**
   * Phrases to look for, matched on word boundaries against the normalised
   * name (lowercased, `-`/`_`/`/` collapsed to spaces). A trailing `s`/`es` is
   * tolerated, so `hut` also matches "Huts" and `beach` also matches "Beaches".
   */
  keywords: string[];
  type: string;
}

export interface ClassificationResult {
  type: string;
  cleanedName: string;
  matchedPrefix: string | null;
  source: 'folder' | 'known-town' | 'prefix' | 'keyword' | 'default';
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
  // Crossings
  'inlets': 'inlet-crossing',
  'inlet crossings': 'inlet-crossing',
  // Points of Interest
  'places of interest': 'poi',
  'sights': 'poi',
  'other': 'poi',
  // Endpoints
  'endpoints': 'endpoint',
  'start/end': 'endpoint',
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
  { prefix: 'IC:', type: 'inlet-crossing' },
  { prefix: 'IC ', type: 'inlet-crossing' },
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
  { prefix: 'S:', type: 'endpoint' },
  { prefix: 'S ', type: 'endpoint' },
  { prefix: 'E:', type: 'endpoint' },
  { prefix: 'E ', type: 'endpoint' },
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
 * Keyword inference rules, in priority order — the FIRST rule with a match
 * wins, so more specific rules must come before the ones they would otherwise
 * be swallowed by: `caravan park` before the parking rules, `water tank`
 * before the generic water rule, `side trip` before `mountain` ("Side trip: Mt
 * Ossa"), and the weak `start`/`finish` terminus rule dead last so "Start
 * Campsite" is a campsite.
 *
 * Every entry is a deliberate bet against false positives. What is *absent* is
 * as load-bearing as what is present:
 * - bare `creek`, `river`, `spring`, `springs`, `dam`, `well`: Australian place
 *   names are full of them ("Falls Creek", "Spring Gully Road", "Finke River"),
 *   and almost none of those are a water source. A water-intent word is
 *   required instead. (`spring` IS accepted as a GPX `<type>` value — see
 *   WATER_TYPE_ALIASES in waypoint-taxonomy — because a type field is an
 *   explicit claim, whereas a name is not.)
 * - bare `camp`: "Camp Road", "Camp Creek", "No camping" are all common.
 *   Only the explicit campsite words below qualify.
 * - bare `park`: "National Park", "Regional Park" — only `car park` /
 *   `carpark` / `parking` mean trail access.
 * - bare `mountain`: "Mountain Bike Trail", "Blue Mountain Road".
 * - bare `inlet`: usually a named body of water, not a crossing point.
 * - `town`/`township`: far too weak a signal to type a waypoint as a resupply
 *   town, which would change food-carry planning. Curated trails use
 *   KNOWN_TOWNS and folders for that.
 */
export const KEYWORD_RULES: WaypointKeywordRule[] = [
  // --- Must precede the parking rules: "caravan park" is accommodation, not
  // trail access. (No bare `park` rule exists, so this is belt-and-braces, but
  // the ordering is asserted by a test so a later `park` entry cannot regress
  // it.) "holiday park"/"tourist park" are the usual AU aliases.
  { keywords: ['caravan park', 'holiday park', 'tourist park'], type: 'caravan-park' },

  // --- Road crossings. Only the explicit "crossing" phrasing; a bare road name
  // is not a crossing.
  { keywords: ['road crossing', 'highway crossing', 'hwy crossing'], type: 'road-crossing' },

  // --- Structural labels the author wrote deliberately, so they outrank every
  // guess below: "Side trip: Mt Ossa" is a side trip first and a mountain
  // second. Explicit phrasing only (see the note on bare `inlet` above).
  { keywords: ['side trip'], type: 'side-trip' },
  { keywords: ['inlet crossing'], type: 'inlet-crossing' },

  // --- Water: a built, usually-reliable store.
  { keywords: ['water tank', 'rainwater', 'rain water', 'tank water'], type: 'water-tank' },
  // --- Water: everything else you can drink from. All of these carry explicit
  // water intent; `soak`, `bore` and `trough` are Australian-specific and
  // unambiguous in a waypoint name.
  {
    keywords: [
      'drinking water',
      'potable water',
      'water source',
      'water point',
      'water tap',
      'water pump',
      'water trough',
      'waterhole',
      'water hole',
      'soak',
      'bore',
      'trough',
      // Bare `tap` survives word-boundary matching cleanly ("Tapin Tops" and
      // "Tapawera" do not match) and means exactly one thing on a trail.
      'tap',
    ],
    type: 'water',
  },

  // --- Campsites. Every form spelt out; see the note above on bare `camp`.
  {
    keywords: [
      'campsite',
      'camp site',
      'campground',
      'camp ground',
      'camping area',
      'camping ground',
      'tentsite',
      'tent site',
      'bush camp',
      'free camp',
    ],
    type: 'campsite',
  },

  // --- Huts. `\bhut\b` deliberately does NOT match "Hutchinson" (tested).
  { keywords: ['hut', 'shelter', 'refuge'], type: 'hut' },

  // --- Accommodation. A `pub`/`tavern` is genuinely ambiguous (a country pub
  // usually serves meals and often has rooms) so it could go to `food` or
  // `accommodation`. It goes to `accommodation`, which is the conservative
  // choice: `accommodation` is excluded from the resupply family, so a pub can
  // never shorten a planned food carry on the strength of a guessed name.
  // In Australia "Hotel" very often means exactly that pub, which makes the two
  // consistent.
  {
    keywords: [
      'hotel',
      'motel',
      'hostel',
      'lodge',
      'b&b',
      'bed and breakfast',
      'guesthouse',
      'guest house',
      'backpackers',
      'cabin',
      'resort',
      'pub',
      'tavern',
    ],
    type: 'accommodation',
  },

  // --- Food. `general store` before bare `store` (same type, but keeps the
  // ordering readable). The chain names are the ones that actually appear in
  // Australian trail notes; `coles` and `iga` do carry known false positives
  // ("Coles Bay", TAS; "Iga Warta", SA) — accepted, because on a walking track
  // the shop reading is overwhelmingly the likely one.
  {
    keywords: [
      'general store',
      'corner store',
      'village store',
      'post office',
      'food drop',
      'food cache',
      'food parcel',
      'supermarket',
      'grocery',
      'groceries',
      'roadhouse',
      'bakery',
      'takeaway',
      'take away',
      'kiosk',
      'cafe',
      'café',
      'deli',
      'store',
      'iga',
      'foodland',
      'coles',
      'woolworths',
      'woolies',
    ],
    type: 'food',
  },
  { keywords: ['resupply'], type: 'resupply' },

  // --- Trail access. See the note above on bare `park`.
  { keywords: ['trailhead', 'trail head', 'track head', 'car park', 'carpark', 'parking'], type: 'trailhead' },

  // --- Peaks. `mt`/`mount` are word-bounded, so "Mount" matches but
  // "Mountain" and "Paramount" do not.
  { keywords: ['summit', 'trig point', 'trig', 'peak', 'mt', 'mount'], type: 'mountain' },

  // --- Points of interest: things worth a stop that are none of the above.
  {
    keywords: ['lookout', 'viewpoint', 'view point', 'waterfall', 'rest area', 'picnic area', 'picnic table', 'toilet'],
    type: 'poi',
  },

  { keywords: ['beach'], type: 'beach' },

  // --- Termini last: `start` and `finish` are the weakest signals here, so
  // anything more specific ("Start Campsite") must have matched already.
  {
    keywords: ['trail start', 'trail end', 'route end', 'end point', 'terminus', 'start', 'finish'],
    type: 'endpoint',
  },
];

/**
 * Normalise a name for keyword matching: lowercase, and collapse the
 * separators that split a word in one file and not another (`Water-tank`,
 * `car_park`, `Start/End`) into spaces so one keyword spelling covers them all.
 */
function normalizeForKeywords(name: string): string {
  return name.toLowerCase().replace(/[-_/\\]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compiled `keyword -> RegExp` cache. `(?:e?s)?` tolerates the plural of every
 * keyword shape we use ("huts", "beaches", "campsites") without needing a
 * second table entry per word.
 */
const keywordPatterns = new Map<string, RegExp>();
function keywordPattern(keyword: string): RegExp {
  let pattern = keywordPatterns.get(keyword);
  if (!pattern) {
    pattern = new RegExp(`\\b${escapeRegExp(keyword)}(?:e?s)?\\b`);
    keywordPatterns.set(keyword, pattern);
  }
  return pattern;
}

/**
 * Infer a waypoint type from words anywhere in its name.
 *
 * Never rewrites the name — unlike the prefix tier, a keyword is evidence
 * about the waypoint, not decoration to strip.
 *
 * @returns the inferred type, or null when no rule matches.
 */
export function inferWaypointTypeFromKeywords(name: string): string | null {
  const normalized = normalizeForKeywords(name);
  if (!normalized) return null;
  for (const rule of KEYWORD_RULES) {
    for (const keyword of rule.keywords) {
      if (keywordPattern(keyword).test(normalized)) return rule.type;
    }
  }
  return null;
}

/**
 * Classify a waypoint by type.
 *
 * Classification priority:
 * 1. GeoJSON folder (if provided) - most reliable, explicit categorization
 * 2. KNOWN_TOWNS set - recognized town/resupply names
 * 3. Prefix matching (with required delimiters) - fallback for GPX-only data
 * 4. Keyword inference - only when `options.inferFromKeywords` is set
 * 5. Default to 'waypoint'
 *
 * @param name - The waypoint name to classify
 * @param options - Optional classification options
 * @returns Classification result with type, cleaned name, and source
 */
export function classifyWaypoint(
  name: string,
  options?: {
    folderName?: string;
    /**
     * Infer a type from keywords anywhere in the name when tiers 1-3 find
     * nothing. Default false: on for user-imported GPX, off for the curated
     * build (see the module header).
     */
    inferFromKeywords?: boolean;
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

  // Priority 4: Keyword inference (opt-in). The name is returned untouched —
  // a keyword is evidence about the waypoint, not a prefix to strip.
  if (options?.inferFromKeywords) {
    const inferred = inferWaypointTypeFromKeywords(trimmedName);
    if (inferred) {
      return {
        type: inferred,
        cleanedName: trimmedName,
        matchedPrefix: null,
        source: 'keyword',
      };
    }
  }

  // Priority 5: Default
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
