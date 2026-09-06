import { describe, expect, it } from "vitest";
import { haversineDistance } from "../../src/lib/distance";
import { MATCH_RADIUS_METERS } from "./waypoint-ids";
import {
  buildCorridor,
  buildOverpassQuery,
  candidateToPoiEntry,
  chunkBounds,
  classifyOsmElement,
  describeOsmCandidate,
  FAMILY_DUPLICATE_RADIUS_M,
  MAX_RULE_RADIUS_M,
  mergeOsmCandidates,
  nearestOnTrack,
  normaliseName,
  coreName,
  sameName,
  OSM_RULES,
  OVERPASS_SELECTORS,
  parsePoisFile,
  planQueryBoxes,
  poisFileToWaypoints,
  waypointFamily,
  type OsmCandidate,
  type OsmTags,
  type PoisFile,
  type TrackKmPoint,
} from "./poi-enrichment";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Offset a lat/lon by metres (good enough at these scales). */
function offset(lat: number, lon: number, northM: number, eastM: number) {
  const dLat = northM / 111_320;
  const dLon = eastM / (111_320 * Math.cos((lat * Math.PI) / 180));
  return { lat: lat + dLat, lon: lon + dLon };
}

/** A straight track heading east from (lat, lon), `count` points `stepM` apart. */
function eastTrack(
  lat: number,
  lon: number,
  count: number,
  stepM: number
): TrackKmPoint[] {
  const points: TrackKmPoint[] = [];
  for (let i = 0; i < count; i++) {
    const p = offset(lat, lon, 0, i * stepM);
    points.push({ ...p, dist: (i * stepM) / 1000 });
  }
  return points;
}

function candidate(
  overrides: Partial<OsmCandidate> & { lat: number; lon: number }
): OsmCandidate {
  return {
    osmId: "node/1",
    name: "Thing",
    type: "water",
    kind: "Drinking water",
    distanceFromTrackM: 10,
    trailKm: 1,
    tags: {},
    ...overrides,
  };
}

const ORIGIN = { lat: -33.95, lon: 115.07 };

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

describe("classifyOsmElement", () => {
  const cases: Array<[OsmTags, string | null, string?]> = [
    [{ amenity: "drinking_water" }, "water", "Drinking water"],
    [{ amenity: "drinking_water", drinking_water: "no" }, null],
    [{ man_made: "water_tank" }, "water-tank", "Water tank"],
    [{ man_made: "water_tap", name: "Camp tap" }, "water", "Camp tap"],
    [{ natural: "spring" }, "water", "Spring"],
    [
      { tourism: "wilderness_hut", name: "Vallejo Gantner Hut" },
      "hut",
      "Vallejo Gantner Hut",
    ],
    [{ amenity: "shelter" }, null],
    [{ amenity: "shelter", name: "Arcadia Campsite" }, "hut", "Arcadia Campsite"],
    [{ amenity: "shelter", shelter_type: "weather_shelter" }, "hut", "Shelter"],
    [{ amenity: "shelter", shelter_type: "basic_hut" }, "hut"],
    [{ amenity: "shelter", shelter_type: "public_transport" }, null],
    [{ amenity: "shelter", shelter_type: "picnic_shelter" }, null],
    [{ tourism: "camp_site", name: "Grimwade" }, "campsite", "Grimwade"],
    [{ tourism: "camp_pitch" }, null],
    [{ tourism: "caravan_site", name: "Big4" }, "caravan-park"],
    [{ tourism: "caravan_site" }, null],
    [{ tourism: "hotel", name: "Grand" }, "accommodation"],
    [{ tourism: "hostel", name: "YHA" }, "accommodation"],
    [{ tourism: "guest_house", name: "Ocean Breeze Beach House" }, null],
    [{ tourism: "chalet", name: "Villa" }, null],
    [{ tourism: "apartment", name: "Flat" }, null],
    [{ shop: "supermarket", name: "IGA" }, "resupply", "IGA"],
    [{ shop: "supermarket" }, null],
    [{ shop: "convenience", name: "Corner Store" }, "resupply"],
    [{ shop: "bakery", name: "Bakehouse" }, "food"],
    [{ shop: "clothes", name: "Boutique" }, null],
    [{ amenity: "fuel", name: "BP" }, "resupply"],
    [{ amenity: "post_office", name: "Australia Post" }, "resupply"],
    [{ amenity: "cafe", name: "Beanz" }, "food"],
    [{ amenity: "pub", name: "Settlers Tavern" }, "food"],
    [{ amenity: "bar", name: "Bar" }, null],
    [{ place: "town", name: "Collie" }, "town"],
    [{ place: "village", name: "Balingup" }, "town"],
    [{ place: "hamlet", name: "Somewhere" }, null],
    [{ place: "locality", name: "Nowhere" }, null],
    [{ highway: "trailhead" }, "trailhead", "Trailhead"],
    [{ tourism: "viewpoint" }, null],
    [{ tourism: "viewpoint", name: "Sand Patches" }, "poi", "Sand Patches"],
    [{ tourism: "picnic_site" }, null],
    [{ tourism: "picnic_site", name: "Conto Picnic Area" }, "poi"],
    [
      {
        tourism: "information",
        information: "visitor_centre",
        name: "MR Visitor Centre",
      },
      "poi",
    ],
    [{ tourism: "information", information: "board" }, null],
    [{ amenity: "hospital", name: "Collie Hospital" }, "poi"],
    [{ amenity: "pharmacy", name: "Chemist" }, "poi"],
    [{ amenity: "police", name: "Police" }, null],
    [{ amenity: "toilets" }, null],
    [{ highway: "bus_stop", name: "Stop" }, null],
    [{ railway: "station", name: "Albany" }, "poi"],
    [{ railway: "station", station: "subway", name: "Metro" }, null],
    [{}, null],
  ];

  it.each(cases)("%j → %s", (tags, type, name) => {
    const result = classifyOsmElement(tags);
    if (type === null) {
      expect(result).toBeNull();
    } else {
      expect(result?.rule.type).toBe(type);
      if (name) expect(result?.name).toBe(name);
    }
  });

  it("collapses whitespace in names", () => {
    expect(
      classifyOsmElement({ amenity: "cafe", name: "  The   Bean \n" })?.name
    ).toBe("The Bean");
  });

  it("treats a whitespace-only name as unnamed", () => {
    expect(classifyOsmElement({ shop: "supermarket", name: "   " })).toBeNull();
    expect(
      classifyOsmElement({ amenity: "drinking_water", name: "   " })?.name
    ).toBe("Drinking water");
  });

  it("gives water rules precedence over shelter rules for combined tags", () => {
    // A tank at a shelter is listed as water — the shelter is usually curated.
    expect(
      classifyOsmElement({ amenity: "shelter", man_made: "water_tank" })?.rule
        .type
    ).toBe("water-tank");
  });
});

describe("OSM_RULES", () => {
  it("every rule radius is at least the id registry match radius", () => {
    // Otherwise an OSM row could sit closer to a curated waypoint than the
    // merge radius yet still match its registry entry.
    for (const family of Object.keys(FAMILY_DUPLICATE_RADIUS_M) as Array<
      keyof typeof FAMILY_DUPLICATE_RADIUS_M
    >) {
      expect(FAMILY_DUPLICATE_RADIUS_M[family]).toBeGreaterThanOrEqual(
        MATCH_RADIUS_METERS
      );
    }
  });

  it("every rule can be reached through the Overpass selectors", () => {
    // Build one representative tag set per rule and check some selector's
    // key/value regex would have fetched it.
    const representative: Record<string, OsmTags> = {
      "Drinking water": { amenity: "drinking_water" },
      "Water tap": { man_made: "water_tap" },
      "Water tank": { man_made: "water_tank" },
      Well: { man_made: "water_well" },
      Spring: { natural: "spring" },
      Hut: { tourism: "wilderness_hut" },
      Shelter: { amenity: "shelter", shelter_type: "weather_shelter" },
      Campsite: { tourism: "camp_site" },
      "Caravan park": { tourism: "caravan_site" },
      Accommodation: { tourism: "hotel" },
      Supermarket: { shop: "supermarket" },
      Shop: { shop: "general" },
      "Service station": { amenity: "fuel" },
      "Post office": { amenity: "post_office" },
      Bakery: { shop: "bakery" },
      Cafe: { amenity: "cafe" },
      Restaurant: { amenity: "fast_food" },
      Pub: { amenity: "pub" },
      Town: { place: "village" },
      Trailhead: { highway: "trailhead" },
      Lookout: { tourism: "viewpoint" },
      "Picnic area": { tourism: "picnic_site" },
      "Visitor centre": {
        tourism: "information",
        information: "visitor_centre",
      },
      Hospital: { amenity: "hospital" },
      Pharmacy: { amenity: "pharmacy" },
      "Railway station": { railway: "halt" },
      "Ferry terminal": { amenity: "ferry_terminal" },
    };
    const selectorMatches = (tags: OsmTags) =>
      OVERPASS_SELECTORS.some((sel) => {
        const m = sel.match(/^\["(\w+)"(=|~)"(.+)"\]$/);
        if (!m) throw new Error(`unparseable selector ${sel}`);
        const [, key, op, value] = m;
        const actual = tags[key];
        if (actual === undefined) return false;
        return op === "=" ? actual === value : new RegExp(value).test(actual);
      });
    for (const rule of OSM_RULES) {
      const tags = representative[rule.kind];
      expect(
        tags,
        `no representative tags for rule "${rule.kind}"`
      ).toBeDefined();
      expect(
        rule.match(tags),
        `rule "${rule.kind}" does not match its own representative`
      ).toBe(true);
      expect(
        selectorMatches(tags),
        `selectors would not fetch "${rule.kind}"`
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// corridor
// ---------------------------------------------------------------------------

describe("buildCorridor", () => {
  it("splits a long line into overlapping chunks", () => {
    // Zig-zag ±50 m so a 1 m tolerance keeps every vertex.
    const track = eastTrack(ORIGIN.lat, ORIGIN.lon, 250, 100).map((p, i) => ({
      ...p,
      ...offset(p.lat, p.lon, i % 2 ? 50 : -50, 0),
    }));
    const chunks = buildCorridor([track], 1, 100);
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 52]);
    // Seams share a vertex.
    expect(chunks[1][0]).toEqual(chunks[0][99]);
    expect(chunks[2][0]).toEqual(chunks[1][99]);
    // Nothing lost at the ends.
    expect(chunks[0][0]).toEqual({ lat: track[0].lat, lon: track[0].lon });
    expect(chunks[2][51]).toEqual({ lat: track[249].lat, lon: track[249].lon });
  });

  it("simplifies a straight line to its endpoints", () => {
    const track = eastTrack(ORIGIN.lat, ORIGIN.lon, 500, 20);
    const chunks = buildCorridor([track], 50, 120);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(2);
  });

  it("drops degenerate polylines and handles several", () => {
    const a = eastTrack(ORIGIN.lat, ORIGIN.lon, 3, 100);
    const chunks = buildCorridor([[], [a[0]], a, a], 0, 120);
    expect(chunks).toHaveLength(2);
  });

  it("strips everything but lat/lon from vertices", () => {
    const chunks = buildCorridor(
      [eastTrack(ORIGIN.lat, ORIGIN.lon, 2, 100)],
      0
    );
    expect(Object.keys(chunks[0][0]).sort()).toEqual(["lat", "lon"]);
  });
});

describe("chunkBounds / planQueryBoxes", () => {
  it("pads a chunk's bbox by the radius in metres", () => {
    const chunk = eastTrack(ORIGIN.lat, ORIGIN.lon, 3, 1000); // 2 km east-west line
    const b = chunkBounds(chunk, 1000);
    expect(b.south).toBeCloseTo(ORIGIN.lat - 1000 / 111_320, 5);
    expect(b.north).toBeCloseTo(ORIGIN.lat + 1000 / 111_320, 5);
    expect(b.west).toBeCloseTo(offset(ORIGIN.lat, ORIGIN.lon, 0, -1000).lon, 4);
    expect(b.east).toBeCloseTo(offset(ORIGIN.lat, ORIGIN.lon, 0, 3000).lon, 4);
  });

  it("folds a nearby variant's box into the main box and keeps a far one", () => {
    const main = eastTrack(ORIGIN.lat, ORIGIN.lon, 50, 1000); // 49 km line
    const insideVariant = eastTrack(ORIGIN.lat, ORIGIN.lon, 3, 500).map((p) =>
      ({ ...offset(p.lat, p.lon, 500, 10_000), dist: 0 }),
    );
    const farVariant = eastTrack(ORIGIN.lat, ORIGIN.lon, 3, 500).map((p) =>
      ({ ...offset(p.lat, p.lon, 20_000, 0), dist: 0 }),
    );
    const chunks = buildCorridor([main, insideVariant, farVariant], 0, 120);
    const groups = planQueryBoxes(chunks, 2500, 4);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
    // Largest box first, and it grew (slightly) to swallow the near variant.
    const [big, small] = groups[0];
    expect(big.east - big.west).toBeGreaterThan(small.east - small.west);
    expect(big.north).toBeGreaterThan(ORIGIN.lat + 2500 / 111_320);
    expect(big.north).toBeLessThan(ORIGIN.lat + 3100 / 111_320);
  });

  it("splits many boxes into groups of perQuery", () => {
    const chunks = Array.from({ length: 9 }, (_, i) =>
      eastTrack(ORIGIN.lat + i * 0.5, ORIGIN.lon, 2, 1000),
    );
    const groups = planQueryBoxes(chunks, 100, 4);
    expect(groups.map((g) => g.length)).toEqual([4, 4, 1]);
  });

  it("rejects bad input", () => {
    expect(() => chunkBounds([], 10)).toThrow();
    expect(() => planQueryBoxes([[ORIGIN]], 10, 0)).toThrow();
  });
});

describe("buildOverpassQuery", () => {
  it("emits every selector for every box", () => {
    const boxes = [
      chunkBounds(eastTrack(ORIGIN.lat, ORIGIN.lon, 3, 100), 500),
      chunkBounds(eastTrack(ORIGIN.lat + 1, ORIGIN.lon, 3, 100), 500),
    ];
    const query = buildOverpassQuery(boxes, 99);
    expect(query).toContain("[out:json][timeout:99];");
    expect(query).toContain("out center tags;");
    const statements = query.match(/^ {2}nwr\[/gm) ?? [];
    expect(statements).toHaveLength(OVERPASS_SELECTORS.length * 2);
    for (const sel of OVERPASS_SELECTORS) expect(query).toContain(`nwr${sel}`);
    const b = boxes[0];
    expect(query).toContain(
      `(${b.south.toFixed(5)},${b.west.toFixed(5)},${b.north.toFixed(5)},${b.east.toFixed(5)})`,
    );
  });

  it("uses the widest rule radius as the default padding", () => {
    expect(MAX_RULE_RADIUS_M).toBe(2500);
    const chunk = eastTrack(ORIGIN.lat, ORIGIN.lon, 2, 100);
    expect(chunkBounds(chunk)).toEqual(chunkBounds(chunk, 2500));
  });

  it("rejects an empty box list", () => {
    expect(() => buildOverpassQuery([])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// nearest point on track
// ---------------------------------------------------------------------------

describe("nearestOnTrack", () => {
  const track = eastTrack(ORIGIN.lat, ORIGIN.lon, 11, 1000); // 10 km, 1 km steps

  it("projects onto the segment interior, not just vertices", () => {
    // 300 m north of the midpoint between vertex 3 (3 km) and 4 (4 km).
    const p = offset(ORIGIN.lat, ORIGIN.lon, 300, 3500);
    const hit = nearestOnTrack(p, track)!;
    expect(hit.distanceM).toBeCloseTo(300, -1);
    expect(hit.km).toBeCloseTo(3.5, 2);
    expect(hit.segmentIndex).toBe(3);
  });

  it("clamps beyond the ends", () => {
    const beyond = offset(ORIGIN.lat, ORIGIN.lon, 0, 12_000);
    const hit = nearestOnTrack(beyond, track)!;
    expect(hit.km).toBeCloseTo(10, 3);
    expect(hit.distanceM).toBeCloseTo(2000, -2);
    const before = offset(ORIGIN.lat, ORIGIN.lon, 0, -500);
    expect(nearestOnTrack(before, track)!.km).toBe(0);
  });

  it("agrees with haversine at a vertex", () => {
    const p = offset(ORIGIN.lat, ORIGIN.lon, 250, 6000);
    const hit = nearestOnTrack(p, track)!;
    const direct = haversineDistance(p.lat, p.lon, track[6].lat, track[6].lon);
    expect(Math.abs(hit.distanceM - direct)).toBeLessThan(1);
  });

  it("handles empty and single-point tracks", () => {
    expect(nearestOnTrack(ORIGIN, [])).toBeNull();
    const single = nearestOnTrack(offset(ORIGIN.lat, ORIGIN.lon, 100, 0), [
      { ...ORIGIN, dist: 4 },
    ])!;
    expect(single.km).toBe(4);
    expect(single.distanceM).toBeCloseTo(100, -1);
  });

  it("picks the closer of two passes of a route", () => {
    // Out along one line and back 2 km north of it.
    const out = eastTrack(ORIGIN.lat, ORIGIN.lon, 6, 1000);
    const north = offset(ORIGIN.lat, ORIGIN.lon, 2000, 0);
    const back = eastTrack(north.lat, north.lon, 6, 1000)
      .reverse()
      .map((p, i) => ({ ...p, dist: 5 + i }));
    const p = offset(ORIGIN.lat, ORIGIN.lon, 1800, 2500);
    const hit = nearestOnTrack(p, [...out, ...back])!;
    expect(hit.distanceM).toBeCloseTo(200, -1);
    expect(hit.km).toBeCloseTo(7.5, 1);
  });
});

// ---------------------------------------------------------------------------
// merging
// ---------------------------------------------------------------------------

describe("waypointFamily / normaliseName", () => {
  it("groups canonical types and GPX aliases", () => {
    expect(waypointFamily("water-tank")).toBe("water");
    expect(waypointFamily("spring")).toBe("water");
    expect(waypointFamily("hut")).toBe("shelter");
    expect(waypointFamily("campsite")).toBe("shelter");
    expect(waypointFamily("caravan-park")).toBe("lodging");
    expect(waypointFamily("town")).toBe("town");
    expect(waypointFamily("supermarket")).toBe("resupply");
    expect(waypointFamily("food")).toBe("food");
    expect(waypointFamily("cafe")).toBe("food");
    expect(waypointFamily("poi")).toBe("other");
    expect(waypointFamily("trailhead")).toBe("other");
  });

  it("matches names that differ only by generic words or Mt/Mount", () => {
    expect(sameName("Long Point", "Long Point Campsite")).toBe(true);
    expect(sameName("Mt Cooke Group Campsite", "Mount Cooke")).toBe(true);
    // A distinctive extra word is a different place (the caravan park, not the town).
    expect(sameName("Balingup", "Balingup Transit Park")).toBe(false);
    expect(sameName("Walpole", "Walpole IGA")).toBe(false);
    expect(sameName("Campsite", "Hut")).toBe(false);
    expect(sameName("Cosy Corner", "Camp Kennedy")).toBe(false);
    expect(coreName("The Mt Cooke Group Campsite")).toBe("mount cooke");
  });

  it("normalises names", () => {
    expect(normaliseName("  Grimwade's  Camp-Site! ")).toBe(
      "grimwade s camp site"
    );
    expect(normaliseName("Fish & Chips")).toBe("fish and chips");
  });
});

describe("mergeOsmCandidates", () => {
  const near = (northM: number, eastM: number) =>
    offset(ORIGIN.lat, ORIGIN.lon, northM, eastM);

  it("drops a candidate covered by a curated waypoint of the same family", () => {
    const curated = [{ name: "Tank 3", type: "water-tank", ...ORIGIN }];
    const c = candidate({
      osmId: "node/1",
      type: "water",
      kind: "Drinking water",
      name: "Drinking water",
      ...near(200, 0),
    });
    const { kept, rejected } = mergeOsmCandidates([c], curated);
    expect(kept).toHaveLength(0);
    expect(rejected[0].reason).toMatch(
      /covered by curated water-tank "Tank 3"/
    );
  });

  it("keeps a candidate of the same family beyond the family radius", () => {
    const curated = [{ name: "Tank 3", type: "water-tank", ...ORIGIN }];
    const c = candidate({
      type: "water",
      ...near(FAMILY_DUPLICATE_RADIUS_M.water + 50, 0),
    });
    expect(mergeOsmCandidates([c], curated).kept).toHaveLength(1);
  });

  it("keeps a candidate of a different family right next to a curated waypoint", () => {
    const curated = [{ name: "Grimwade Hut", type: "hut", ...ORIGIN }];
    const c = candidate({
      type: "water",
      name: "Drinking water",
      ...near(20, 0),
    });
    expect(mergeOsmCandidates([c], curated).kept).toHaveLength(1);
  });

  it("drops a same-name candidate whatever its type", () => {
    const curated = [{ name: "Blackwood Camp", type: "campsite", ...ORIGIN }];
    const c = candidate({
      type: "poi",
      kind: "Picnic area",
      name: "Blackwood  camp!",
      ...near(900, 0),
    });
    const { kept, rejected } = mergeOsmCandidates([c], curated);
    expect(kept).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/same name/);
  });

  it("drops a candidate whose core name matches a curated waypoint 500 m away", () => {
    const curated = [{ name: "Long Point", type: "campsite", ...ORIGIN }];
    const c = candidate({ type: "campsite", kind: "Campsite", name: "Long Point Campsite", ...near(0, 700) });
    const { kept, rejected } = mergeOsmCandidates([c], curated);
    expect(kept).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/same name as curated campsite "Long Point"/);
  });

  it("treats an OSM row co-located with a covered OSM row as covered", () => {
    const curated = [{ name: "Long Point", type: "campsite", ...ORIGIN }];
    const site = candidate({ osmId: "way/1", type: "campsite", kind: "Campsite", name: "Long Point Campsite", distanceFromTrackM: 270, ...near(0, 700) });
    const hut = candidate({ osmId: "node/2", type: "hut", kind: "Hut", name: "Hut", distanceFromTrackM: 275, ...near(5, 705) });
    const { kept, rejected } = mergeOsmCandidates([site, hut], curated);
    expect(kept).toHaveLength(0);
    expect(rejected.map((r) => r.candidate.osmId)).toEqual(["way/1", "node/2"]);
    expect(rejected[1].reason).toMatch(/co-located with OSM way\/1/);
  });

  it("collapses a town's place node and boundary centre kilometres apart", () => {
    const a = candidate({ osmId: "node/1", type: "town", kind: "Town", name: "Little Grove", distanceFromTrackM: 1300, ...near(0, 0) });
    const b = candidate({ osmId: "relation/2", type: "town", kind: "Town", name: "Little Grove", distanceFromTrackM: 1900, ...near(0, 2000) });
    expect(mergeOsmCandidates([a, b], []).kept.map((k) => k.osmId)).toEqual(["node/1"]);
  });

  it("uses the wide town radius for town-vs-town only", () => {
    const curated = [{ name: "Balingup", type: "town", ...ORIGIN }];
    const townNode = candidate({
      osmId: "node/1",
      type: "town",
      kind: "Town",
      name: "Balingup Village",
      ...near(2500, 0),
    });
    const shop = candidate({
      osmId: "node/2",
      type: "resupply",
      kind: "Shop",
      name: "Balingup General Store",
      ...near(300, 0),
    });
    const cafe = candidate({
      osmId: "node/3",
      type: "food",
      kind: "Cafe",
      name: "Mushroom Cafe",
      ...near(100, 0),
    });
    const { kept, rejected } = mergeOsmCandidates(
      [townNode, shop, cafe],
      curated
    );
    expect(rejected.map((r) => r.candidate.osmId)).toEqual(["node/1"]);
    expect(kept.map((k) => k.osmId).sort()).toEqual(["node/2", "node/3"]);
  });

  it("requires the exact type for the 'other' family", () => {
    const curated = [{ name: "Big Lookout", type: "poi", ...ORIGIN }];
    const hospital = candidate({
      osmId: "node/1",
      type: "poi",
      kind: "Hospital",
      name: "Hospital",
      ...near(50, 0),
    });
    const trailhead = candidate({
      osmId: "node/2",
      type: "trailhead",
      kind: "Trailhead",
      name: "Trailhead",
      ...near(50, 0),
    });
    const { kept, rejected } = mergeOsmCandidates(
      [hospital, trailhead],
      curated
    );
    // Same type `poi` within 200 m → covered; different type → kept.
    expect(rejected.map((r) => r.candidate.osmId)).toEqual(["node/1"]);
    expect(kept.map((k) => k.osmId)).toEqual(["node/2"]);
  });

  it("ignores curated rows that are themselves OSM output", () => {
    const curated = [
      { name: "Drinking water", type: "water", source: "osm", ...ORIGIN },
    ];
    const c = candidate({ type: "water", ...ORIGIN });
    expect(mergeOsmCandidates([c], curated).kept).toHaveLength(1);
  });

  it("collapses same-name OSM twins keeping the one nearer the track", () => {
    const a = candidate({
      osmId: "way/9",
      type: "resupply",
      kind: "Supermarket",
      name: "IGA",
      distanceFromTrackM: 400,
      ...near(0, 0),
    });
    const b = candidate({
      osmId: "node/8",
      type: "resupply",
      kind: "Supermarket",
      name: "IGA",
      distanceFromTrackM: 350,
      ...near(40, 0),
    });
    const { kept, rejected } = mergeOsmCandidates([a, b], []);
    expect(kept.map((k) => k.osmId)).toEqual(["node/8"]);
    expect(rejected[0].reason).toMatch(/duplicate of OSM node\/8/);
  });

  it("collapses unnamed same-type OSM twins only when very close", () => {
    const a = candidate({
      osmId: "node/1",
      name: "Drinking water",
      ...near(0, 0),
      distanceFromTrackM: 5,
    });
    const b = candidate({
      osmId: "node/2",
      name: "Drinking water",
      ...near(30, 0),
      distanceFromTrackM: 6,
    });
    const c = candidate({
      osmId: "node/3",
      name: "Drinking water",
      ...near(150, 0),
      distanceFromTrackM: 7,
    });
    const { kept } = mergeOsmCandidates([a, b, c], []);
    expect(kept.map((k) => k.osmId)).toEqual(["node/1", "node/3"]);
  });

  it("does not collapse distinct named shops near each other", () => {
    const a = candidate({
      osmId: "node/1",
      type: "food",
      kind: "Cafe",
      name: "Cafe A",
      ...near(0, 0),
    });
    const b = candidate({
      osmId: "node/2",
      type: "food",
      kind: "Cafe",
      name: "Cafe B",
      ...near(20, 0),
    });
    expect(mergeOsmCandidates([a, b], []).kept).toHaveLength(2);
  });

  it("caps food rows per kilometre, keeping the ones nearest the track", () => {
    const cafes = Array.from({ length: 6 }, (_, i) =>
      candidate({
        osmId: `node/${i + 1}`,
        type: "food",
        kind: "Cafe",
        name: `Cafe ${i + 1}`,
        distanceFromTrackM: 100 * (i + 1),
        ...near(0, 50 * i),
      })
    );
    const { kept, rejected } = mergeOsmCandidates(cafes, []);
    expect(kept.map((k) => k.osmId)).toEqual(["node/1", "node/2", "node/3"]);
    expect(rejected).toHaveLength(3);
    expect(rejected[0].reason).toMatch(/cluster cap: already 3 food rows/);
  });

  it("admits the supermarket before nearer shops when the resupply cap bites", () => {
    const shops = Array.from({ length: 4 }, (_, i) =>
      candidate({
        osmId: `node/${i + 1}`,
        type: "resupply",
        kind: "Shop",
        name: `Shop ${i + 1}`,
        distanceFromTrackM: 50 * (i + 1),
        ...near(0, 30 * i),
      })
    );
    const supermarket = candidate({
      osmId: "node/9",
      type: "resupply",
      kind: "Supermarket",
      name: "IGA",
      distanceFromTrackM: 900,
      ...near(0, 400),
    });
    const { kept } = mergeOsmCandidates([...shops, supermarket], []);
    expect(kept.map((k) => k.name)).toContain("IGA");
    expect(kept).toHaveLength(4);
  });

  it("caps 'other' rows per kind, and never caps water", () => {
    const lookouts = Array.from({ length: 4 }, (_, i) =>
      candidate({ osmId: `node/${i + 1}`, type: "poi", kind: "Lookout", name: `View ${i}`, ...near(0, 20 * i) })
    );
    const pharmacy = candidate({ osmId: "node/8", type: "poi", kind: "Pharmacy", name: "Chemist", ...near(0, 10) });
    const taps = Array.from({ length: 5 }, (_, i) =>
      candidate({ osmId: `node/${20 + i}`, type: "water", kind: "Water tap", name: `Tap ${i}`, ...near(0, 100 * i) })
    );
    const { kept } = mergeOsmCandidates([...lookouts, pharmacy, ...taps], []);
    expect(kept.filter((k) => k.kind === "Lookout")).toHaveLength(3);
    expect(kept.filter((k) => k.kind === "Pharmacy")).toHaveLength(1);
    expect(kept.filter((k) => k.type === "water")).toHaveLength(5);
  });

  it("does not let far-apart food rows count toward each other's cap", () => {
    const cafes = Array.from({ length: 5 }, (_, i) =>
      candidate({ osmId: `node/${i + 1}`, type: "food", kind: "Cafe", name: `Cafe ${i}`, ...near(0, 3000 * i) })
    );
    expect(mergeOsmCandidates(cafes, []).kept).toHaveLength(5);
  });

  it("orders survivors along the trail", () => {
    const a = candidate({ osmId: "node/1", trailKm: 12, ...near(0, 0) });
    const b = candidate({ osmId: "node/2", trailKm: 3, ...near(0, 5000) });
    expect(mergeOsmCandidates([a, b], []).kept.map((k) => k.osmId)).toEqual([
      "node/2",
      "node/1",
    ]);
  });
});

// ---------------------------------------------------------------------------
// descriptions and file round-trip
// ---------------------------------------------------------------------------

describe("describeOsmCandidate", () => {
  it("summarises useful tags and ends with attribution", () => {
    const text = describeOsmCandidate({
      kind: "Cafe",
      osmId: "node/42",
      tags: {
        opening_hours: "Mo-Fr 08:00-16:00",
        phone: "+61 8 0000 0000",
        fee: "yes",
        operator: "Shire",
      },
    });
    expect(text).toBe(
      "Cafe. Fee applies. Operator: Shire. Hours: Mo-Fr 08:00-16:00. Phone: +61 8 0000 0000. " +
        "Source: OpenStreetMap contributors (ODbL), https://www.openstreetmap.org/node/42"
    );
  });

  it("truncates long free-text descriptions", () => {
    const text = describeOsmCandidate({
      kind: "Hut",
      osmId: "way/1",
      tags: { description: "x".repeat(1000) },
    });
    expect(text.length).toBeLessThan(500);
    expect(text).toContain("…");
  });

  it("does not double up full stops", () => {
    const text = describeOsmCandidate({
      kind: "Hut",
      osmId: "way/1",
      tags: { description: "Sleeps six." },
    });
    expect(text).toContain("Hut. Sleeps six. Source");
  });
});

describe("pois.json", () => {
  const entryCandidate = candidate({
    osmId: "node/7",
    name: "Corner Store",
    type: "resupply",
    kind: "Shop",
    lat: -33.123456789,
    lon: 115.987654321,
    distanceFromTrackM: 123.6,
    trailKm: 45.678,
    tags: {
      shop: "convenience",
      name: "Corner Store",
      opening_hours: "24/7",
      "addr:street": "Main St",
    },
  });

  it("candidateToPoiEntry rounds and keeps only reviewable tags", () => {
    const entry = candidateToPoiEntry(entryCandidate);
    expect(entry).toEqual({
      osmId: "node/7",
      name: "Corner Store",
      type: "resupply",
      kind: "Shop",
      lat: -33.123457,
      lon: 115.987654,
      distanceFromTrackM: 124,
      trailKm: 45.7,
      tags: {
        shop: "convenience",
        name: "Corner Store",
        opening_hours: "24/7",
      },
    });
  });

  it("parsePoisFile validates shape", () => {
    const good = {
      trailId: "t",
      rejected: ["node/1"],
      pois: [candidateToPoiEntry(entryCandidate)],
    };
    expect(parsePoisFile(good, "p").pois).toHaveLength(1);
    expect(() => parsePoisFile({ trailId: "t" }, "p")).toThrow(/pois array/);
    expect(() =>
      parsePoisFile({ trailId: "t", pois: [], rejected: ["7"] }, "p")
    ).toThrow(/rejected/);
    expect(() =>
      parsePoisFile(
        {
          trailId: "t",
          pois: [{ osmId: "node/1", name: "x", type: "poi", lat: "a", lon: 1 }],
        },
        "p"
      )
    ).toThrow(/pois\[0\]: bad lat\/lon/);
    expect(() => parsePoisFile({ pois: [] }, "p")).toThrow(/trailId/);
  });

  it("poisFileToWaypoints honours rejected ids and re-merges against curated", () => {
    const file: PoisFile = {
      trailId: "t",
      source: "s",
      fetchedAt: "",
      rejected: ["node/2"],
      pois: [
        candidateToPoiEntry(
          candidate({ osmId: "node/1", name: "Drinking water", ...ORIGIN })
        ),
        candidateToPoiEntry(
          candidate({
            osmId: "node/2",
            name: "Spring",
            kind: "Spring",
            ...offset(ORIGIN.lat, ORIGIN.lon, 0, 5000),
          })
        ),
        candidateToPoiEntry(
          candidate({
            osmId: "node/3",
            name: "Tap",
            kind: "Water tap",
            ...offset(ORIGIN.lat, ORIGIN.lon, 0, 10_000),
          })
        ),
      ],
    };
    // A curated tank added after the fetch sits on top of node/3.
    const curated = [
      {
        name: "New Tank",
        type: "water-tank",
        ...offset(ORIGIN.lat, ORIGIN.lon, 30, 10_000),
      },
    ];
    const { waypoints, skipped } = poisFileToWaypoints(file, curated);
    expect(waypoints.map((w) => w.name)).toEqual(["Drinking water"]);
    expect(waypoints[0]).toMatchObject({
      source: "osm",
      type: "water",
      lat: ORIGIN.lat,
      lon: ORIGIN.lon,
    });
    expect(waypoints[0].description).toContain(
      "https://www.openstreetmap.org/node/1"
    );
    expect(skipped.map((s) => `${s.osmId}:${s.reason}`)).toEqual([
      "node/2:in rejected list",
      'node/3:covered by curated water-tank "New Tank" 30 m away',
    ]);
  });
});
