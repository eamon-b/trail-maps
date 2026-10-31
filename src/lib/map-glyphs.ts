/**
 * The map glyph set: one small silhouette per kind of place, shared by the
 * phone's map (rasterised to `mobile/assets/map-icons/*.png` by
 * `mobile/scripts/build-map-icons.mjs`) and the web's maps and tables (inlined
 * as SVG by `waypoint-glyphs.ts` `glyphSvg`). One set, so a hut looks like a hut
 * on both — and no emoji, whose look depends on the reader's fonts and whose
 * newer code points draw as empty boxes on older systems.
 *
 * Each value is the body of a 96x96 SVG, drawn inside a ~76px centred box and
 * inked with `currentColor` (the PNG build substitutes its fixed ink; the web
 * sets `color`). Keep the geometry simple — paths, rects and circles, solid
 * fills or strokes of at least 11 — because the glyph is seen at 10-14 px:
 * finer strokes read lighter than the solid glyphs beside them, and detail
 * smaller than that disappears.
 *
 * This file has no imports and uses only erasable TypeScript, so the PNG
 * build script can load it directly with Node's type stripping.
 */

const INK = 'currentColor';
const STROKE = `fill="none" stroke="${INK}" stroke-linecap="round" stroke-linejoin="round"`;

export const MAP_GLYPH_NAMES = [
  'water',
  'water-tank',
  'campsite',
  'hut',
  'bed',
  'teahouse',
  'town',
  'resupply',
  'trailhead',
  'endpoint',
  'junction',
  'milestone',
  'gap',
  'note',
  'road',
  'ford',
  'summit',
  'hazard',
  'info',
  'beach',
  'restaurant',
  'transport',
  'emergency',
  'poi',
] as const;

export type MapGlyphName = (typeof MAP_GLYPH_NAMES)[number];

/** name -> SVG body (96x96 viewBox, `currentColor` ink). */
export const MAP_GLYPHS: Readonly<Record<MapGlyphName, string>> = {
  // Water: a drop.
  water: `<path fill="${INK}" d="M48 14 C60 33 74 45 74 58 A26 26 0 1 1 22 58 C22 45 36 33 48 14 Z"/>`,

  // Water tank: a raised tank on two legs with a drop cut out of it — the
  // legs are what keep it from reading as a jar.
  'water-tank': `
    <path fill="${INK}" fill-rule="evenodd" d="M24 22 A8 8 0 0 1 32 14 H64 A8 8 0 0 1 72 22 V58 A8 8 0 0 1 64 66 H32 A8 8 0 0 1 24 58 Z M48 24 C53 32 59 37 59 44 A11 11 0 1 1 37 44 C37 37 43 32 48 24 Z"/>
    <rect fill="${INK}" x="28" y="62" width="10" height="22" rx="3"/>
    <rect fill="${INK}" x="58" y="62" width="10" height="22" rx="3"/>`,

  // Campsite: a tent with a door notch.
  campsite: `<path fill="${INK}" d="M48 18 L84 78 H62 L48 48 L34 78 H12 Z"/>`,

  // Hut / shelter: a cabin with a doorway.
  hut: `<path fill="${INK}" d="M48 18 L84 48 H76 V78 H56 V56 H40 V78 H20 V48 H12 Z"/>`,

  // Accommodation: a bed.
  bed: `
    <rect fill="${INK}" x="12" y="34" width="11" height="44" rx="4"/>
    <rect fill="${INK}" x="12" y="52" width="72" height="15" rx="5"/>
    <rect fill="${INK}" x="27" y="40" width="21" height="12" rx="5"/>
    <rect fill="${INK}" x="73" y="52" width="11" height="26" rx="4"/>`,

  // Teahouse: a steaming cup on a saucer — a lodge that is also a meal and a
  // water stop, so neither the cabin nor the bed.
  teahouse: `
    <path ${STROKE} stroke-width="9" d="M33 31 C27 25 39 20 33 12 M53 31 C47 25 59 20 53 12"/>
    <path fill="${INK}" d="M16 38 H70 V54 A22 22 0 0 1 48 76 H38 A22 22 0 0 1 16 54 Z"/>
    <circle ${STROKE} stroke-width="9" cx="73" cy="52" r="10"/>
    <rect fill="${INK}" x="10" y="78" width="72" height="9" rx="4"/>`,

  // Town: two houses either side of a steepled hall, spaced apart. Pitched
  // roofs, so it is a settlement rather than a bar chart.
  town: `
    <path fill="${INK}" d="M8 56 L21 43 L34 56 V80 H8 Z"/>
    <path fill="${INK}" fill-rule="evenodd" d="M39 36 L48 20 L57 36 V80 H39 Z M44 44 H52 V54 H44 Z"/>
    <path fill="${INK}" d="M62 56 L75 43 L88 56 V80 H62 Z"/>`,

  // Resupply / food: a shopping bag.
  resupply: `
    <path fill="${INK}" d="M22 34 H74 L79 78 H17 Z"/>
    <path ${STROKE} stroke-width="8" d="M36 34 A12 12 0 0 1 60 34"/>`,

  // Trailhead: a signpost pointing both ways.
  trailhead: `
    <rect fill="${INK}" x="44" y="14" width="10" height="66" rx="4"/>
    <path fill="${INK}" d="M54 26 H75 L83 34 L75 42 H54 Z"/>
    <path fill="${INK}" d="M44 48 H23 L15 56 L23 64 H44 Z"/>`,

  // Trail end / terminus: a flag (pole and pennant centred as one shape).
  endpoint: `
    <rect fill="${INK}" x="23" y="14" width="10" height="68" rx="4"/>
    <path fill="${INK}" d="M33 18 H75 L62 32 L75 46 H33 Z"/>`,

  // Junction: a fork in the trail.
  junction: `<path ${STROKE} stroke-width="12" d="M48 82 L48 52 L25 24 M48 52 L71 24"/>`,

  // Milestone: a distance post — a plate reading "10" on a stake (the CDT's
  // every-10-mile markers).
  milestone: `
    <path fill="${INK}" fill-rule="evenodd" d="M22 18 A6 6 0 0 1 28 12 H68 A6 6 0 0 1 74 18 V52 A6 6 0 0 1 68 58 H28 A6 6 0 0 1 22 52 Z M32 22 H40 V48 H32 Z M47 26 A4 4 0 0 1 51 22 H60 A4 4 0 0 1 64 26 V44 A4 4 0 0 1 60 48 H51 A4 4 0 0 1 47 44 Z M53 28 H58 V42 H53 Z"/>
    <rect fill="${INK}" x="42" y="54" width="12" height="30" rx="3"/>`,

  // Trail gap: a bar broken in two, the ends cut on a slant like a tear.
  gap: `
    <path fill="${INK}" d="M8 40 H42 L34 58 H8 Z"/>
    <path fill="${INK}" d="M62 40 H88 V58 H54 Z"/>`,

  // A note on a printed map sheet: a page with ruled lines.
  note: `
    <path fill="${INK}" fill-rule="evenodd" d="M18 12 H78 V84 H18 Z M28 28 H68 V36 H28 Z M28 44 H68 V52 H28 Z M28 60 H54 V68 H28 Z"/>`,

  // Road / road crossing: two verges with a centre line.
  road: `
    <path ${STROKE} stroke-width="11" d="M24 16 V80 M72 16 V80"/>
    <rect fill="${INK}" x="42" y="16" width="12" height="16" rx="4"/>
    <rect fill="${INK}" x="42" y="40" width="12" height="16" rx="4"/>
    <rect fill="${INK}" x="42" y="64" width="12" height="16" rx="4"/>`,

  // Ford / wet crossing: stepping stones across a stream (not the beach's
  // surf, which is the other waves glyph).
  ford: `
    <path ${STROKE} stroke-width="10" d="M12 26 Q24 16 36 26 T60 26 T84 26 M12 72 Q24 62 36 72 T60 72 T84 72"/>
    <ellipse fill="${INK}" cx="20" cy="49" rx="10" ry="7"/>
    <ellipse fill="${INK}" cx="48" cy="49" rx="10" ry="7"/>
    <ellipse fill="${INK}" cx="76" cy="49" rx="10" ry="7"/>`,

  // Lookout / summit: two peaks, the taller with a snow line cut into it.
  summit: `<path fill="${INK}" fill-rule="evenodd" d="M8 80 L38 22 L54 52 L64 36 L88 80 Z M38 34 L30 50 L36 46 L41 52 L46 46 Z"/>`,

  // Hazard: the standard warning triangle (holes via even-odd fill).
  hazard: `<path fill="${INK}" fill-rule="evenodd" d="M48 14 L86 80 H10 Z M44 36 H52 V58 H44 Z M44 63 H52 V72 H44 Z"/>`,

  // Information.
  info: `<path fill="${INK}" fill-rule="evenodd" d="M13 48 A35 35 0 1 1 83 48 A35 35 0 1 1 13 48 Z M43 40 H53 V70 H43 Z M43 24 H53 V35 H43 Z"/>`,

  // Beach: sun over surf.
  beach: `
    <circle fill="${INK}" cx="60" cy="28" r="14"/>
    <path ${STROKE} stroke-width="11" d="M12 56 Q24 44 36 56 T60 56 T84 56 M12 76 Q24 64 36 76 T60 76 T84 76"/>`,

  // Restaurant / cafe / pub: a fork and a knife.
  restaurant: `
    <rect fill="${INK}" x="20" y="14" width="6" height="26" rx="3"/>
    <rect fill="${INK}" x="29" y="14" width="6" height="26" rx="3"/>
    <rect fill="${INK}" x="38" y="14" width="6" height="26" rx="3"/>
    <path fill="${INK}" d="M20 34 H44 V40 A12 12 0 0 1 20 40 Z"/>
    <rect fill="${INK}" x="28" y="44" width="8" height="38" rx="4"/>
    <path fill="${INK}" d="M56 54 V26 C56 18 62 14 68 14 C72 22 74 32 74 42 C74 49 69 54 56 54 Z"/>
    <rect fill="${INK}" x="61" y="46" width="8" height="36" rx="4"/>`,

  // Public transport: a bus front (windows cut out via even-odd) over two wheels.
  transport: `
    <path fill="${INK}" fill-rule="evenodd" d="M18 24 A10 10 0 0 1 28 14 H68 A10 10 0 0 1 78 24 V58 A6 6 0 0 1 72 64 H24 A6 6 0 0 1 18 58 Z M25 24 H45 V42 H25 Z M51 24 H71 V42 H51 Z"/>
    <circle fill="${INK}" cx="31" cy="73" r="9"/>
    <circle fill="${INK}" cx="65" cy="73" r="9"/>`,

  // Emergency: a first-aid cross.
  emergency: `
    <rect fill="${INK}" x="37" y="12" width="22" height="72" rx="8"/>
    <rect fill="${INK}" x="12" y="37" width="72" height="22" rx="8"/>`,

  // Generic point of interest — the fallback for unmapped types.
  poi: `
    <circle fill="${INK}" cx="48" cy="48" r="13"/>
    <circle ${STROKE} stroke-width="11" cx="48" cy="48" r="29"/>`,
};
