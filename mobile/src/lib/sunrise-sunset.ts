/**
 * Sunrise/sunset calculator using the NOAA Solar Position Algorithm.
 *
 * Accurate to within a few minutes for latitudes between -60° and 60°,
 * which covers all of Australia (≈ -10° to -44°).
 *
 * Returns UTC Date objects — JavaScript will display them in the device's
 * local timezone automatically, including DST.
 *
 * Reference: https://gml.noaa.gov/grad/solcalc/solareqns.PDF
 */

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/** Julian Day Number at midnight UTC for a given calendar date (local year/month/day). */
function julianDayAtMidnightUTC(year: number, month: number, day: number): number {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  // Julian Day Number (at noon UT)
  const jdn =
    day +
    Math.floor((153 * m + 2) / 5) +
    365 * y +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400) -
    32045;
  // JD at midnight UTC = JDN - 0.5
  return jdn - 0.5;
}

/** Julian Century from J2000.0 (Jan 1.5, 2000) */
function julianCentury(jd: number): number {
  return (jd - 2451545.0) / 36525.0;
}

/** Geometric mean longitude of the sun (degrees) */
function geomMeanLongSun(t: number): number {
  let l = 280.46646 + t * (36000.76983 + t * 0.0003032);
  l = ((l % 360) + 360) % 360;
  return l;
}

/** Geometric mean anomaly of the sun (degrees) */
function geomMeanAnomalySun(t: number): number {
  return 357.52911 + t * (35999.05029 - 0.0001537 * t);
}

/** Eccentricity of Earth's orbit */
function eccentricityEarthOrbit(t: number): number {
  return 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
}

/** Equation of center of the sun (degrees) */
function equationOfCenter(t: number): number {
  const mRad = toRad(geomMeanAnomalySun(t));
  return (
    Math.sin(mRad) * (1.9146 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * mRad) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * mRad) * 0.00029
  );
}

/** Sun's true longitude (degrees) */
function sunTrueLong(t: number): number {
  return geomMeanLongSun(t) + equationOfCenter(t);
}

/** Sun's apparent longitude (degrees), correcting for nutation and aberration */
function sunApparentLong(t: number): number {
  const l = sunTrueLong(t);
  const omega = 125.04 - 1934.136 * t;
  return l - 0.00569 - 0.00478 * Math.sin(toRad(omega));
}

/** Mean obliquity of the ecliptic (degrees) */
function meanObliquityEcliptic(t: number): number {
  const seconds = 21.448 - t * (46.815 + t * (0.00059 - t * 0.001813));
  return 23 + (26 + seconds / 60) / 60;
}

/** Corrected obliquity of the ecliptic (degrees) */
function obliquityCorrection(t: number): number {
  const e0 = meanObliquityEcliptic(t);
  const omega = 125.04 - 1934.136 * t;
  return e0 + 0.00256 * Math.cos(toRad(omega));
}

/** Sun's declination (degrees) */
function sunDeclination(t: number): number {
  const e = obliquityCorrection(t);
  const lambda = sunApparentLong(t);
  const sint = Math.sin(toRad(e)) * Math.sin(toRad(lambda));
  return toDeg(Math.asin(sint));
}

/** Equation of Time (minutes) */
function equationOfTime(t: number): number {
  const eps = obliquityCorrection(t);
  const l0 = geomMeanLongSun(t);
  const e = eccentricityEarthOrbit(t);
  const m = geomMeanAnomalySun(t);

  const y = Math.tan(toRad(eps / 2)) ** 2;

  const etime =
    y * Math.sin(2 * toRad(l0)) -
    2 * e * Math.sin(toRad(m)) +
    4 * e * y * Math.sin(toRad(m)) * Math.cos(2 * toRad(l0)) -
    0.5 * y * y * Math.sin(4 * toRad(l0)) -
    1.25 * e * e * Math.sin(2 * toRad(m));

  return toDeg(etime) * 4; // convert to minutes
}

export interface SunTimes {
  sunrise: Date;
  sunset: Date;
}

/**
 * Calculate sunrise and sunset times for a given location and date.
 *
 * @param lat  Latitude in decimal degrees (negative = south)
 * @param lon  Longitude in decimal degrees (negative = west)
 * @param date Local date whose year/month/day determine the calculation day
 * @returns UTC sunrise and sunset Date objects, or null if polar day/night
 */
export function getSunriseSunset(
  lat: number,
  lon: number,
  date: Date,
): SunTimes | null {
  const year = date.getFullYear();
  const month = date.getMonth() + 1; // 1–12
  const day = date.getDate();

  const jd = julianDayAtMidnightUTC(year, month, day);

  // Use solar noon (JD + 0.5) for the main calculation pass
  const t = julianCentury(jd + 0.5);

  const eqTime = equationOfTime(t);
  const solarDec = sunDeclination(t);

  // Hour angle for 90.833° zenith (accounts for atmospheric refraction + solar disc)
  const latRad = toRad(lat);
  const sdRad = toRad(solarDec);
  const cosHA =
    Math.cos(toRad(90.833)) / (Math.cos(latRad) * Math.cos(sdRad)) -
    Math.tan(latRad) * Math.tan(sdRad);

  // Polar day (sun never sets) or polar night (sun never rises)
  if (cosHA > 1 || cosHA < -1) return null;

  const hourAngleDeg = toDeg(Math.acos(cosHA));

  // Solar noon in minutes from midnight UTC
  const solarNoonMinutes = 720 - 4 * lon - eqTime;

  // Sunrise/sunset in minutes from midnight UTC
  const sunriseMinutes = solarNoonMinutes - 4 * hourAngleDeg;
  const sunsetMinutes = solarNoonMinutes + 4 * hourAngleDeg;

  const baseUTC = Date.UTC(year, month - 1, day);

  const sunrise = new Date(baseUTC + sunriseMinutes * 60 * 1000);
  const sunset = new Date(baseUTC + sunsetMinutes * 60 * 1000);

  return { sunrise, sunset };
}

/** Whether it is currently daylight (between sunrise and sunset). */
export function isDaylight(sunTimes: SunTimes, now: Date = new Date()): boolean {
  return now >= sunTimes.sunrise && now <= sunTimes.sunset;
}

/**
 * Minutes until the next sun event (sunrise or sunset).
 * Returns positive minutes to next event and which event it is.
 */
export function minutesToNextEvent(
  sunTimes: SunTimes,
  now: Date = new Date(),
): { event: 'sunrise' | 'sunset'; minutesUntil: number } {
  const nowMs = now.getTime();
  if (nowMs < sunTimes.sunrise.getTime()) {
    return {
      event: 'sunrise',
      minutesUntil: Math.round((sunTimes.sunrise.getTime() - nowMs) / 60_000),
    };
  }
  if (nowMs < sunTimes.sunset.getTime()) {
    return {
      event: 'sunset',
      minutesUntil: Math.round((sunTimes.sunset.getTime() - nowMs) / 60_000),
    };
  }
  // After sunset — next event is tomorrow's sunrise; return 0 as proxy
  return { event: 'sunrise', minutesUntil: 0 };
}

/**
 * Format a Date as a local time string "HH:MM".
 * Uses the device's local timezone automatically.
 */
export function formatLocalTime(date: Date): string {
  const h = date.getHours().toString().padStart(2, '0');
  const m = date.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Format minutes into "Xh Ym" or "Ym" string.
 */
export function formatDuration(totalMinutes: number): string {
  if (totalMinutes <= 0) return '0m';
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}
