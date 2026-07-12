/**
 * WGS84 -> UTM conversion for the coordinates readout (rescue use case).
 *
 * Implements the classic Transverse Mercator series (Snyder, "Map Projections
 * — A Working Manual", the same series used by the widely-used `utm` library).
 * Accurate to well under a metre across a zone — far inside GPS fix error — so
 * no external dependency is pulled in.
 *
 * DATUM HONESTY: this projects on the WGS84 ellipsoid. Australian maps quote
 * MGA2020, which is UTM on the GDA2020 datum. WGS84 and GDA2020 differ by well
 * under 2 m at the current epoch — smaller than a typical GPS fix error — so the
 * output is fine for relaying a position to rescue, but it is NOT survey-grade
 * MGA2020. The UI therefore labels the format "UTM (MGA)", not "MGA2020".
 *
 * Zone exceptions: the standard UTM zone exceptions for southern Norway (zone
 * 32V) and Svalbard (zones 31X/33X/35X/37X) are intentionally NOT implemented —
 * they only affect high northern latitudes and are irrelevant to an Australian
 * trails app.
 */

export interface UtmCoordinate {
  zone: number;
  /** MGRS latitude band letter (C..X, excluding I and O). */
  band: string;
  hemisphere: 'N' | 'S';
  /** Metres east of the zone's false-easting origin. */
  easting: number;
  /** Metres north (from equator, or false-north 10,000,000 in the south). */
  northing: number;
}

// WGS84 ellipsoid.
const A = 6378137; // semi-major axis (m)
const F = 1 / 298.257223563; // flattening
const E = F * (2 - F); // first eccentricity squared
const E2 = E * E;
const E3 = E2 * E;
const E_P2 = E / (1 - E); // second eccentricity squared

const K0 = 0.9996; // UTM scale factor on the central meridian

// Meridional-arc series coefficients (in terms of eccentricity squared).
const M1 = 1 - E / 4 - (3 * E2) / 64 - (5 * E3) / 256;
const M2 = (3 * E) / 8 + (3 * E2) / 32 + (45 * E3) / 1024;
const M3 = (15 * E2) / 256 + (45 * E3) / 1024;
const M4 = (35 * E3) / 3072;

// MGRS latitude bands, 8° each from -80°, with X spanning 72°..84°. I and O are
// omitted (they read as 1 and 0). Index = floor((lat + 80) / 8).
const ZONE_LETTERS = 'CDEFGHJKLMNPQRSTUVWXX';

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** UTM zone number from longitude (Australian app — no Norway/Svalbard cases). */
export function utmZone(lon: number): number {
  return Math.floor((lon + 180) / 6) + 1;
}

/** MGRS latitude band letter, or 'Z' outside the [-80°, 84°] band grid. */
export function utmBand(lat: number): string {
  if (lat < -80 || lat > 84) return 'Z';
  return ZONE_LETTERS[Math.floor((lat + 80) / 8)];
}

/** Project a WGS84 lat/lon to UTM. See the datum note at the top of the file. */
export function toUtm(lat: number, lon: number): UtmCoordinate {
  const latRad = toRad(lat);
  const latSin = Math.sin(latRad);
  const latCos = Math.cos(latRad);
  const latTan = latSin / latCos;
  const latTan2 = latTan * latTan;
  const latTan4 = latTan2 * latTan2;

  const zone = utmZone(lon);
  const centralLon = (zone - 1) * 6 - 180 + 3;
  const dLon = toRad(lon) - toRad(centralLon);

  const n = A / Math.sqrt(1 - E * latSin * latSin);
  const c = E_P2 * latCos * latCos;

  const p = latCos * dLon;
  const p2 = p * p;
  const p3 = p2 * p;
  const p4 = p3 * p;
  const p5 = p4 * p;
  const p6 = p5 * p;

  const m =
    A *
    (M1 * latRad -
      M2 * Math.sin(2 * latRad) +
      M3 * Math.sin(4 * latRad) -
      M4 * Math.sin(6 * latRad));

  const easting =
    K0 *
      n *
      (p +
        (p3 / 6) * (1 - latTan2 + c) +
        (p5 / 120) *
          (5 - 18 * latTan2 + latTan4 + 72 * c - 58 * E_P2)) +
    500000;

  let northing =
    K0 *
    (m +
      n *
        latTan *
        (p2 / 2 +
          (p4 / 24) * (5 - latTan2 + 9 * c + 4 * c * c) +
          (p6 / 720) *
            (61 - 58 * latTan2 + latTan4 + 600 * c - 330 * E_P2)));

  // Southern hemisphere gets the 10,000,000 m false northing so values stay
  // positive.
  if (lat < 0) northing += 10000000;

  return {
    zone,
    band: utmBand(lat),
    hemisphere: lat < 0 ? 'S' : 'N',
    easting,
    northing,
  };
}

/**
 * Display string for the rescue use case, e.g. "56H 334901E 6252289N": zone +
 * MGRS band letter, whole-metre easting (6 digits) and northing (7 digits),
 * zero-padded.
 */
export function formatUtm(lat: number, lon: number): string {
  const { zone, band, easting, northing } = toUtm(lat, lon);
  const e = String(Math.round(easting)).padStart(6, '0');
  const n = String(Math.round(northing)).padStart(7, '0');
  return `${zone}${band} ${e}E ${n}N`;
}
