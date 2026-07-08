/**
 * Aggregate Open-Meteo daily climate series into monthly averages.
 *
 * Extracted from scripts/fetch-climate.ts so the mobile app can reuse the
 * exact same aggregation at runtime for custom (imported) trails. Pure math —
 * no I/O, safe for React Native.
 */

export interface MonthlyClimate {
  month: number;
  avgTempMin: number;
  avgTempMax: number;
  avgPrecipitation: number;
  avgRainyDays: number;
}

/**
 * Daily series as returned by the Open-Meteo archive API
 * (`daily=temperature_2m_max,temperature_2m_min,precipitation_sum`).
 * Values may contain nulls where the API has no data.
 */
export interface DailyClimateSeries {
  time: string[];
  temperature_2m_max: (number | null)[];
  temperature_2m_min: (number | null)[];
  precipitation_sum: (number | null)[];
}

/**
 * Aggregate daily data into monthly averages.
 *
 * For each calendar month (1-12) across all years in the series:
 * - avgTempMin/avgTempMax: mean over all days with temperature data
 * - avgPrecipitation: total precipitation divided by the number of years
 * - avgRainyDays: days with >1mm precipitation divided by the number of years
 *
 * Months with no data yield all-zero entries so the output always has 12 rows.
 */
export function aggregateDailyToMonthly(daily: DailyClimateSeries): MonthlyClimate[] {
  const { time, temperature_2m_max, temperature_2m_min, precipitation_sum } = daily;

  // Group data by month
  const monthlyData: Map<number, {
    tempMaxSum: number;
    tempMinSum: number;
    precipSum: number;
    rainyDays: number;
    count: number;
    yearCount: Set<number>;
  }> = new Map();

  for (let i = 0; i < time.length; i++) {
    // Open-Meteo `time` entries are date-only ISO strings ('YYYY-MM-DD').
    // `new Date('YYYY-MM-DD')` parses as UTC midnight (per ECMA-262), so
    // reading the month/year with local getters shifts every 1st-of-month
    // into the previous month on UTC-negative devices. Slice the ISO string
    // directly to bucket by calendar date regardless of the device timezone.
    const month = Number(time[i].slice(5, 7)); // 1-12
    const year = Number(time[i].slice(0, 4));

    if (!monthlyData.has(month)) {
      monthlyData.set(month, {
        tempMaxSum: 0,
        tempMinSum: 0,
        precipSum: 0,
        rainyDays: 0,
        count: 0,
        yearCount: new Set(),
      });
    }

    const entry = monthlyData.get(month)!;
    const tempMax = temperature_2m_max[i];
    const tempMin = temperature_2m_min[i];
    const precip = precipitation_sum[i];

    // Skip null/undefined values
    if (tempMax != null && tempMin != null) {
      entry.tempMaxSum += tempMax;
      entry.tempMinSum += tempMin;
      entry.count++;
      entry.yearCount.add(year);
    }

    if (precip != null) {
      entry.precipSum += precip;
      if (precip > 1) {
        entry.rainyDays++;
      }
    }
  }

  // Calculate averages
  const monthly: MonthlyClimate[] = [];

  for (let month = 1; month <= 12; month++) {
    const entry = monthlyData.get(month);
    if (!entry || entry.count === 0) {
      // No data for this month
      monthly.push({
        month,
        avgTempMin: 0,
        avgTempMax: 0,
        avgPrecipitation: 0,
        avgRainyDays: 0,
      });
      continue;
    }

    const numYears = entry.yearCount.size;

    monthly.push({
      month,
      avgTempMin: Math.round(entry.tempMinSum / entry.count * 10) / 10,
      avgTempMax: Math.round(entry.tempMaxSum / entry.count * 10) / 10,
      avgPrecipitation: Math.round(entry.precipSum / numYears * 10) / 10,
      avgRainyDays: Math.round(entry.rainyDays / numYears * 10) / 10,
    });
  }

  return monthly;
}
