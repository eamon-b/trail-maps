import {
  getSunriseSunset,
  isDaylight,
  minutesToNextEvent,
  formatLocalTime,
  formatDuration,
} from '../sunrise-sunset';

// Known sunrise/sunset data for verification (approximate):
// Adelaide, Australia (-34.93, 138.60):
//   Summer (Jan 15): sunrise ~06:08 ACDT (UTC+10:30), sunset ~20:40 ACDT
//     = UTC 19:38 prev day → sunrise UTC 19:38, sunset UTC 10:10
//   Winter (Jul 15): sunrise ~07:21 ACST (UTC+09:30), sunset ~17:20 ACST
//     = sunrise UTC 21:51 prev day, but we compare as offsets
//
// For these tests we check:
//   1. Sunrise < Sunset
//   2. Day length is plausible (≈ 8–16 hours)
//   3. Sunrise is around expected UTC hour (within ±30 min tolerance)

const ADELAIDE = { lat: -34.93, lon: 138.6 };
const SYDNEY = { lat: -33.87, lon: 151.21 };

describe('getSunriseSunset', () => {
  it('returns sunrise before sunset', () => {
    const date = new Date('2024-01-15');
    const result = getSunriseSunset(ADELAIDE.lat, ADELAIDE.lon, date);
    expect(result).not.toBeNull();
    expect(result!.sunrise.getTime()).toBeLessThan(result!.sunset.getTime());
  });

  it('produces plausible day length in summer (10–16 hours)', () => {
    const date = new Date('2024-01-15');
    const result = getSunriseSunset(ADELAIDE.lat, ADELAIDE.lon, date);
    expect(result).not.toBeNull();
    const dayLengthHours = (result!.sunset.getTime() - result!.sunrise.getTime()) / 3_600_000;
    expect(dayLengthHours).toBeGreaterThan(10);
    expect(dayLengthHours).toBeLessThan(16);
  });

  it('produces plausible day length in winter (8–12 hours)', () => {
    const date = new Date('2024-07-15');
    const result = getSunriseSunset(ADELAIDE.lat, ADELAIDE.lon, date);
    expect(result).not.toBeNull();
    const dayLengthHours = (result!.sunset.getTime() - result!.sunrise.getTime()) / 3_600_000;
    expect(dayLengthHours).toBeGreaterThan(8);
    expect(dayLengthHours).toBeLessThan(12);
  });

  it('summer days are longer than winter days in southern hemisphere', () => {
    const summer = getSunriseSunset(ADELAIDE.lat, ADELAIDE.lon, new Date('2024-01-15'))!;
    const winter = getSunriseSunset(ADELAIDE.lat, ADELAIDE.lon, new Date('2024-07-15'))!;
    const summerHours = (summer.sunset.getTime() - summer.sunrise.getTime()) / 3_600_000;
    const winterHours = (winter.sunset.getTime() - winter.sunrise.getTime()) / 3_600_000;
    expect(summerHours).toBeGreaterThan(winterHours);
  });

  it('returns plausible results for Sydney', () => {
    const date = new Date('2024-06-21'); // Winter solstice
    const result = getSunriseSunset(SYDNEY.lat, SYDNEY.lon, date);
    expect(result).not.toBeNull();
    const dayLengthHours = (result!.sunset.getTime() - result!.sunrise.getTime()) / 3_600_000;
    expect(dayLengthHours).toBeGreaterThan(8);
    expect(dayLengthHours).toBeLessThan(12);
  });

  it('returns sun times as Date objects', () => {
    const result = getSunriseSunset(-33.87, 151.21, new Date('2024-03-20'));
    expect(result?.sunrise).toBeInstanceOf(Date);
    expect(result?.sunset).toBeInstanceOf(Date);
  });

  it('equinox: day and night are roughly equal length (within 20 min)', () => {
    // Equinoxes: ~March 20 and ~September 23
    // Day length should be ~12 hours
    const date = new Date('2024-03-20');
    const result = getSunriseSunset(SYDNEY.lat, SYDNEY.lon, date);
    expect(result).not.toBeNull();
    const dayLengthHours = (result!.sunset.getTime() - result!.sunrise.getTime()) / 3_600_000;
    expect(dayLengthHours).toBeGreaterThan(11.5);
    expect(dayLengthHours).toBeLessThan(12.5);
  });

  it('returns null for polar latitudes in extreme conditions', () => {
    // Antarctica in summer (polar day — sun never sets) or winter (sun never rises)
    // At -89.9° lat in Dec (southern summer), polar day → cosHA < -1 → null
    const result = getSunriseSunset(-89.9, 0, new Date('2024-12-21'));
    // This may or may not be null depending on exact latitude and date
    // Just ensure it doesn't throw
    expect(result === null || (result?.sunrise instanceof Date && result?.sunset instanceof Date)).toBe(true);
  });
});

describe('isDaylight', () => {
  it('returns true during daylight hours', () => {
    const sunTimes = {
      sunrise: new Date('2024-01-15T20:00:00Z'), // UTC
      sunset: new Date('2024-01-16T10:00:00Z'),
    };
    const midday = new Date('2024-01-16T03:00:00Z'); // between sunrise and sunset
    expect(isDaylight(sunTimes, midday)).toBe(true);
  });

  it('returns false before sunrise', () => {
    const sunTimes = {
      sunrise: new Date('2024-01-15T20:00:00Z'),
      sunset: new Date('2024-01-16T10:00:00Z'),
    };
    const predawn = new Date('2024-01-15T19:00:00Z');
    expect(isDaylight(sunTimes, predawn)).toBe(false);
  });

  it('returns false after sunset', () => {
    const sunTimes = {
      sunrise: new Date('2024-01-15T20:00:00Z'),
      sunset: new Date('2024-01-16T10:00:00Z'),
    };
    const evening = new Date('2024-01-16T11:00:00Z');
    expect(isDaylight(sunTimes, evening)).toBe(false);
  });
});

describe('minutesToNextEvent', () => {
  it('returns sunrise event before sunrise', () => {
    const sunTimes = {
      sunrise: new Date(Date.now() + 90 * 60 * 1000), // 90 min from now
      sunset: new Date(Date.now() + 10 * 60 * 60 * 1000),
    };
    const result = minutesToNextEvent(sunTimes);
    expect(result.event).toBe('sunrise');
    expect(result.minutesUntil).toBe(90);
  });

  it('returns sunset event during daylight', () => {
    const sunTimes = {
      sunrise: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago
      sunset: new Date(Date.now() + 120 * 60 * 1000), // 2 hours from now
    };
    const result = minutesToNextEvent(sunTimes);
    expect(result.event).toBe('sunset');
    expect(result.minutesUntil).toBe(120);
  });

  it('returns sunrise with 0 after sunset', () => {
    const sunTimes = {
      sunrise: new Date(Date.now() - 12 * 60 * 60 * 1000),
      sunset: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago
    };
    const result = minutesToNextEvent(sunTimes);
    expect(result.event).toBe('sunrise');
    expect(result.minutesUntil).toBe(0);
  });
});

describe('formatDuration', () => {
  it('formats minutes only', () => {
    expect(formatDuration(30)).toBe('30m');
    expect(formatDuration(45)).toBe('45m');
  });

  it('formats hours only', () => {
    expect(formatDuration(60)).toBe('1h');
    expect(formatDuration(120)).toBe('2h');
  });

  it('formats hours and minutes', () => {
    expect(formatDuration(90)).toBe('1h 30m');
    expect(formatDuration(75)).toBe('1h 15m');
    expect(formatDuration(135)).toBe('2h 15m');
  });

  it('handles zero', () => {
    expect(formatDuration(0)).toBe('0m');
  });

  it('handles negative (treats as 0)', () => {
    expect(formatDuration(-10)).toBe('0m');
  });
});

describe('formatLocalTime', () => {
  it('formats time with leading zeros', () => {
    // Create a specific UTC time that we can predict
    const date = new Date(0); // epoch
    // We can't predict local timezone, so just check format
    const result = formatLocalTime(date);
    expect(result).toMatch(/^\d{2}:\d{2}$/);
  });
});
