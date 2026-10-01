/**
 * Night topo: the light basemap, repainted for a dark app.
 *
 * The dark map used to be a different style altogether — OpenFreeMap's `dark`
 * (a Dark-Matter derivative) online and a near-black palette offline. Both are
 * built for a dashboard backdrop: no forest, no parks, no relief, roads barely
 * above the ground. On a hiking guide that throws away most of what the map is
 * for. This module keeps every layer of the light style (Liberty online, the
 * topo template offline) and moves only its colours, by the role each colour
 * plays:
 *
 *   area   (fills, background) — inverted in lightness into a slate band, so
 *          the cream ground goes dark and landcover that sat a little darker
 *          than cream (forest, grass, water) sits a little *lighter* than the
 *          ground: still a visible patch, in its own hue.
 *   line   (roads, rivers, paths) — compressed, not inverted, into a mid band:
 *          a white road stays the lightest line on the map and a yellow one
 *          stays yellow, just dimmer.
 *   text   — inverted to light ink; coloured labels (water, peaks) keep hue.
 *   halo   — near-black, keeping the source's alpha.
 *
 * Saturation is capped per role, because a pastel at 70% lightness turns
 * garish once it is pulled down to 25%. Hue is never touched — green is still
 * forest and blue is still water. Raster layers (Liberty's low-zoom shaded
 * relief) are dimmed rather than recoloured, and sprite-backed patterns are
 * faded, since neither can be repainted.
 *
 * Every colour is matched where it appears, including inside expressions
 * (`interpolate` stops, `match` outputs), so a style that grows a zoom ramp
 * on a colour is still covered. A string that does not parse as a colour is
 * left alone, so a property name or a font inside an expression can never be
 * mangled.
 */

export type ColorRole = 'area' | 'line' | 'text' | 'halo';

interface Hsla {
  h: number; // 0-360
  s: number; // 0-1
  l: number; // 0-1
  a: number; // 0-1
}

const NAMED: Record<string, string> = {
  white: '#ffffff',
  black: '#000000',
  transparent: 'rgba(0,0,0,0)',
};

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function rgbToHsl(r: number, g: number, b: number, a: number): Hsla {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l, a };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l, a };
}

/** Parse a CSS colour (hex, rgb[a], hsl[a], a few names) or return null. */
export function parseColor(input: string): Hsla | null {
  const str = (NAMED[input.trim().toLowerCase()] ?? input).trim().toLowerCase();

  const hex = /^#([0-9a-f]{3,8})$/.exec(str);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    return rgbToHsl(n(0), n(2), n(4), h.length === 8 ? n(6) : 1);
  }

  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(str);
  if (!fn) return null;
  const parts = fn[2].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  const alpha = parts[3] === undefined
    ? 1
    : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
  if (Number.isNaN(alpha)) return null;

  if (fn[1].startsWith('rgb')) {
    const ch = parts.slice(0, 3).map((p) =>
      p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p) / 255,
    );
    if (ch.some(Number.isNaN)) return null;
    return rgbToHsl(clamp01(ch[0]), clamp01(ch[1]), clamp01(ch[2]), clamp01(alpha));
  }

  const h = parseFloat(parts[0]);
  const s = parseFloat(parts[1]) / 100;
  const l = parseFloat(parts[2]) / 100;
  if ([h, s, l].some(Number.isNaN)) return null;
  return { h: ((h % 360) + 360) % 360, s: clamp01(s), l: clamp01(l), a: clamp01(alpha) };
}

function formatHsla({ h, s, l, a }: Hsla): string {
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const hsl = `${r1(h)},${r1(s * 100)}%,${r1(l * 100)}%`;
  return a >= 1 ? `hsl(${hsl})` : `hsla(${hsl},${Math.round(a * 1000) / 1000})`;
}

/**
 * Lightness and saturation curves per role. `l` takes the source lightness and
 * returns the night one; `sMax` caps saturation.
 */
const ROLES: Record<ColorRole, { l: (l: number) => number; sMax: number }> = {
  // cream 0.96 -> 0.16; forest/grass ~0.75 -> ~0.24; buildings 0.82 -> 0.21
  area: { l: (l) => 0.145 + (1 - l) * 0.38, sMax: 0.25 },
  // white 1.0 -> 0.6; yellow road 0.83 -> 0.53; casing 0.69 -> 0.48
  line: { l: (l) => 0.2 + l * 0.4, sMax: 0.45 },
  // #333 0.2 -> 0.86; water-label blue 0.43 -> 0.74
  text: { l: (l) => 0.93 - l * 0.45, sMax: 0.45 },
  halo: { l: () => 0.1, sMax: 0.2 },
};

/**
 * Water keeps more of its colour than other areas: at night lightness a lake is
 * told from the forest around it by hue alone, and a grey-blue lake on a
 * grey-green ground is easy to miss.
 */
const WATER_HUES = [180, 250];
const WATER_S_MAX = 0.55;

function isWaterHue(h: number): boolean {
  return h >= WATER_HUES[0] && h <= WATER_HUES[1];
}

/** Map one colour string to its night value, or return it unchanged. */
export function nightColor(color: string, role: ColorRole): string {
  const c = parseColor(color);
  if (!c) return color;
  const rule = ROLES[role];
  const sMax = role === 'area' && isWaterHue(c.h) ? WATER_S_MAX : rule.sMax;
  return formatHsla({ h: c.h, s: Math.min(c.s, sMax), l: clamp01(rule.l(c.l)), a: c.a });
}

/** Walk a paint value (a literal or an expression) repainting colour strings. */
function mapColors(value: unknown, role: ColorRole): unknown {
  if (typeof value === 'string') return nightColor(value, role);
  if (Array.isArray(value)) return value.map((v) => mapColors(v, role));
  if (value && typeof value === 'object') {
    // Legacy function syntax: { stops: [[zoom, colour], ...] }
    const fn = value as { stops?: unknown };
    if (Array.isArray(fn.stops)) return { ...fn, stops: mapColors(fn.stops, role) };
  }
  return value;
}

function roleFor(property: string): ColorRole | null {
  if (!property.endsWith('-color')) return null;
  if (property.endsWith('halo-color')) return 'halo';
  if (property.startsWith('text-') || property.startsWith('icon-')) return 'text';
  if (property.startsWith('line-') || property.startsWith('circle-stroke')) return 'line';
  return 'area';
}

type Layer = { id: string; type?: string; paint?: Record<string, unknown> };

/** Repaint one layer for the night map. Returns a new layer; never mutates. */
export function nightLayer<T extends Layer>(layer: T): T {
  const paint: Record<string, unknown> = { ...(layer.paint ?? {}) };
  for (const [prop, value] of Object.entries(paint)) {
    const role = roleFor(prop);
    if (role) paint[prop] = mapColors(value, role);
  }
  if (layer.type === 'raster') {
    // Shaded relief: keep the shading, lose the glare.
    paint['raster-brightness-max'] = 0.35;
    paint['raster-saturation'] = -0.4;
  }
  if (layer.type === 'fill' && 'fill-pattern' in paint) {
    // Sprite patterns cannot be recoloured; fade them into the ground.
    const opacity = typeof paint['fill-opacity'] === 'number' ? paint['fill-opacity'] : 1;
    paint['fill-opacity'] = Math.round(opacity * 0.35 * 100) / 100;
  }
  return { ...layer, paint };
}

/**
 * Repaint every layer of a style for the night map. Takes ownership of the
 * style's `layers` array (pass a clone), replacing each entry.
 */
export function applyNightPalette(style: { layers: Layer[] }): void {
  for (let i = 0; i < style.layers.length; i++) {
    style.layers[i] = nightLayer(style.layers[i]);
  }
}
