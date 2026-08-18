/**
 * Generates the guide map's waypoint marker glyphs.
 *
 * The map must work fully offline, so marker iconography cannot come from a
 * remote sprite sheet, an icon font, or emoji (the bundled glyph pbfs only
 * cover Latin + punctuation + a few maths/arrow blocks — no pictographs). The
 * icons are therefore committed PNG assets registered with MapLibre's <Images>.
 *
 * Each glyph is authored here as a small SVG and rasterised to
 * `assets/map-icons/<name>.png` at 96x96 (declared scale 1, drawn at ~0.175
 * icon-size, so a 3x screen still samples down rather than up).
 *
 * The glyph is a single ink silhouette on a transparent background: the white
 * badge and the category-coloured ring underneath are drawn by GuideMap's
 * CircleLayer, which is what keeps the category colour theme-resolved instead
 * of baked into a bitmap.
 *
 * Requires ImageMagick with the librsvg delegate (`magick -list format | grep SVG`).
 *
 *   node scripts/build-map-icons.mjs      (or: npm run build:map-icons)
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'assets', 'map-icons');
const TMP_DIR = join(HERE, '..', '.map-icons-tmp');

/** Canvas edge in px. Glyphs are drawn inside a ~72px centred box. */
const SIZE = 96;
/** Glyph ink. Fixed map cartography (see GuideMap's LABEL_TEXT), not a theme token. */
const INK = '#1A1A1A';

const STROKE = `fill="none" stroke="${INK}" stroke-linecap="round" stroke-linejoin="round"`;

/**
 * name -> SVG body. Keep the geometry simple (paths / rects / circles only):
 * librsvg renders these identically everywhere, and simple silhouettes stay
 * readable at ~13 dp on screen.
 */
const GLYPHS = {
  // Water: a drop.
  water: `<path fill="${INK}" d="M48 14 C60 33 74 45 74 58 A26 26 0 1 1 22 58 C22 45 36 33 48 14 Z"/>`,

  // Water tank: a tank with a drop cut out of it (distinct from a plain drop).
  'water-tank': `<path fill="${INK}" fill-rule="evenodd" d="M26 30 A22 8 0 0 1 70 30 V70 A22 8 0 0 1 26 70 Z M48 36 C54 45 61 50 61 57 A13 13 0 1 1 35 57 C35 50 42 45 48 36 Z"/>`,

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

  // Town: a skyline of three buildings.
  town: `
    <rect fill="${INK}" x="12" y="46" width="22" height="32" rx="2"/>
    <rect fill="${INK}" x="38" y="26" width="22" height="52" rx="2"/>
    <rect fill="${INK}" x="64" y="54" width="20" height="24" rx="2"/>`,

  // Resupply / food: a shopping bag.
  resupply: `
    <path fill="${INK}" d="M22 34 H74 L79 78 H17 Z"/>
    <path ${STROKE} stroke-width="8" d="M36 34 A12 12 0 0 1 60 34"/>`,

  // Trailhead: a signpost pointing both ways.
  trailhead: `
    <rect fill="${INK}" x="44" y="14" width="10" height="66" rx="4"/>
    <path fill="${INK}" d="M54 26 H75 L83 34 L75 42 H54 Z"/>
    <path fill="${INK}" d="M44 48 H23 L15 56 L23 64 H44 Z"/>`,

  // Trail end / terminus: a flag.
  endpoint: `
    <rect fill="${INK}" x="28" y="14" width="10" height="66" rx="4"/>
    <path fill="${INK}" d="M38 18 H78 L66 32 L78 46 H38 Z"/>`,

  // Junction: a fork in the trail.
  junction: `<path ${STROKE} stroke-width="10" d="M48 80 L48 52 L26 26 M48 52 L70 26"/>`,

  // Road / road crossing: two verges with a centre line.
  road: `
    <path ${STROKE} stroke-width="9" d="M26 16 V80 M70 16 V80"/>
    <rect fill="${INK}" x="43" y="18" width="10" height="15" rx="4"/>
    <rect fill="${INK}" x="43" y="41" width="10" height="15" rx="4"/>
    <rect fill="${INK}" x="43" y="64" width="10" height="15" rx="4"/>`,

  // Ford / inlet crossing: water to wade.
  ford: `<path ${STROKE} stroke-width="9" d="M14 34 Q25 22 36 34 T58 34 T80 34 M14 54 Q25 42 36 54 T58 54 T80 54 M14 74 Q25 62 36 74 T58 74 T80 74"/>`,

  // Lookout / summit: peaks under a sun.
  summit: `
    <circle fill="${INK}" cx="72" cy="26" r="9"/>
    <path fill="${INK}" d="M10 78 L34 34 L50 62 L60 46 L86 78 Z"/>`,

  // Hazard: the standard warning triangle (holes via even-odd fill).
  hazard: `<path fill="${INK}" fill-rule="evenodd" d="M48 14 L86 80 H10 Z M44 36 H52 V58 H44 Z M44 63 H52 V72 H44 Z"/>`,

  // Information.
  info: `<path fill="${INK}" fill-rule="evenodd" d="M13 48 A35 35 0 1 1 83 48 A35 35 0 1 1 13 48 Z M43 40 H53 V70 H43 Z M43 24 H53 V35 H43 Z"/>`,

  // Beach: sun over surf.
  beach: `
    <circle fill="${INK}" cx="60" cy="28" r="14"/>
    <path ${STROKE} stroke-width="9" d="M14 56 Q25 44 36 56 T58 56 T80 56 M14 74 Q25 62 36 74 T58 74 T80 74"/>`,

  // Generic point of interest — the fallback for unmapped types.
  poi: `
    <circle fill="${INK}" cx="48" cy="48" r="12"/>
    <circle ${STROKE} stroke-width="9" cx="48" cy="48" r="28"/>`,
};

function svgDocument(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${body}</svg>`;
}

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(TMP_DIR, { recursive: true });

for (const [name, body] of Object.entries(GLYPHS)) {
  const svgPath = join(TMP_DIR, `${name}.svg`);
  const pngPath = join(OUT_DIR, `${name}.png`);
  writeFileSync(svgPath, svgDocument(body));
  execFileSync('magick', [
    '-background',
    'none',
    svgPath,
    '-resize',
    `${SIZE}x${SIZE}`,
    `png32:${pngPath}`,
  ]);
  console.log(`wrote ${pngPath}`);
}

rmSync(TMP_DIR, { recursive: true, force: true });
console.log(`${Object.keys(GLYPHS).length} icons written to assets/map-icons/`);
