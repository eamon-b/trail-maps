import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { aggregateDailyToMonthly, type DailyClimateSeries } from './climate-aggregate';

function emptySeries(): DailyClimateSeries {
  return { time: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_sum: [] };
}

/** Build a series covering the given days with constant values. */
function buildSeries(
  days: { date: string; max: number | null; min: number | null; precip: number | null }[],
): DailyClimateSeries {
  return {
    time: days.map(d => d.date),
    temperature_2m_max: days.map(d => d.max),
    temperature_2m_min: days.map(d => d.min),
    precipitation_sum: days.map(d => d.precip),
  };
}

describe('aggregateDailyToMonthly', () => {
  it('returns 12 all-zero months for an empty series', () => {
    const monthly = aggregateDailyToMonthly(emptySeries());
    expect(monthly).toHaveLength(12);
    monthly.forEach((m, i) => {
      expect(m).toEqual({
        month: i + 1,
        avgTempMin: 0,
        avgTempMax: 0,
        avgPrecipitation: 0,
        avgRainyDays: 0,
      });
    });
  });

  it('averages temperatures over days and precipitation over years', () => {
    // Two Januaries (2020, 2021), two days each
    const monthly = aggregateDailyToMonthly(buildSeries([
      { date: '2020-01-01', max: 30, min: 15, precip: 0 },
      { date: '2020-01-02', max: 32, min: 17, precip: 4 },
      { date: '2021-01-01', max: 28, min: 13, precip: 2 },
      { date: '2021-01-02', max: 30, min: 15, precip: 0.5 },
    ]));

    const jan = monthly[0];
    expect(jan.month).toBe(1);
    // Temps averaged over 4 days
    expect(jan.avgTempMax).toBe(30);
    expect(jan.avgTempMin).toBe(15);
    // Precip totalled then divided by 2 years: (0+4+2+0.5)/2 = 3.3 (rounded 0.1)
    expect(jan.avgPrecipitation).toBe(3.3);
    // Rainy days (>1mm): 2020-01-02 and 2021-01-01 → 2 days / 2 years = 1
    expect(jan.avgRainyDays).toBe(1);
    // Other months remain zeroed
    expect(monthly[5]).toEqual({
      month: 6,
      avgTempMin: 0,
      avgTempMax: 0,
      avgPrecipitation: 0,
      avgRainyDays: 0,
    });
  });

  it('rounds averages to one decimal place', () => {
    const monthly = aggregateDailyToMonthly(buildSeries([
      { date: '2020-03-01', max: 20.11, min: 10.11, precip: 1.06 },
      { date: '2020-03-02', max: 20.22, min: 10.22, precip: 1.06 },
      { date: '2020-03-03', max: 20.44, min: 10.44, precip: 1.06 },
    ]));

    const mar = monthly[2];
    // (20.11+20.22+20.44)/3 = 20.256... → 20.3
    expect(mar.avgTempMax).toBe(20.3);
    expect(mar.avgTempMin).toBe(10.3);
    // 3.18 total / 1 year → 3.2
    expect(mar.avgPrecipitation).toBe(3.2);
    expect(mar.avgRainyDays).toBe(3);
  });

  it('skips null temperature days but still counts their precipitation', () => {
    const monthly = aggregateDailyToMonthly(buildSeries([
      { date: '2020-07-01', max: 10, min: 2, precip: 0 },
      { date: '2020-07-02', max: null, min: null, precip: 6 },
    ]));

    const jul = monthly[6];
    // Temperature average uses only the one valid day
    expect(jul.avgTempMax).toBe(10);
    expect(jul.avgTempMin).toBe(2);
    // Precipitation from the null-temp day still counts
    expect(jul.avgPrecipitation).toBe(6);
    expect(jul.avgRainyDays).toBe(1);
  });

  it('treats a month with only null temperatures as having no data', () => {
    const monthly = aggregateDailyToMonthly(buildSeries([
      { date: '2020-09-01', max: null, min: null, precip: 12 },
    ]));

    expect(monthly[8]).toEqual({
      month: 9,
      avgTempMin: 0,
      avgTempMax: 0,
      avgPrecipitation: 0,
      avgRainyDays: 0,
    });
  });

  it('does not count precipitation of exactly 1mm as a rainy day', () => {
    const monthly = aggregateDailyToMonthly(buildSeries([
      { date: '2020-11-01', max: 25, min: 12, precip: 1 },
      { date: '2020-11-02', max: 25, min: 12, precip: 1.1 },
    ]));

    expect(monthly[10].avgRainyDays).toBe(1);
  });

  // Regression: date-only strings must bucket by their literal calendar month
  // regardless of the device timezone. `new Date('2020-01-01')` is UTC midnight,
  // so a local getMonth()/getFullYear() on a UTC-negative device would push
  // Jan-1 into the previous December, inflating December and understating it.
  describe('timezone-independent month bucketing', () => {
    const originalTZ = process.env.TZ;
    beforeAll(() => { process.env.TZ = 'America/Los_Angeles'; });
    afterAll(() => { process.env.TZ = originalTZ; });

    it('places 1st-of-month rows in their own month under a UTC-negative tz', () => {
      const monthly = aggregateDailyToMonthly(buildSeries([
        { date: '2014-01-01', max: 30, min: 15, precip: 5 },
        { date: '2015-01-01', max: 30, min: 15, precip: 5 },
      ]));

      const jan = monthly[0];
      const dec = monthly[11];

      // Both Jan-1 rows land in January...
      expect(jan.month).toBe(1);
      expect(jan.avgTempMax).toBe(30);
      // precip totalled then divided by 2 distinct years: (5+5)/2 = 5
      expect(jan.avgPrecipitation).toBe(5);
      expect(jan.avgRainyDays).toBe(1);

      // ...and nothing bleeds into December.
      expect(dec).toEqual({
        month: 12,
        avgTempMin: 0,
        avgTempMax: 0,
        avgPrecipitation: 0,
        avgRainyDays: 0,
      });
    });
  });
});
