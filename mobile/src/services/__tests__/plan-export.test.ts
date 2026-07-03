import type { ComputedDay } from '../plan-calculator-types';
import type { DayClimate } from '../climate-service';
import { exportPlanAsText, exportPlanAsCsv } from '../plan-export';

// ---------------------------------------------------------------------------
// Helpers: build test data
// ---------------------------------------------------------------------------

interface ExportPlan {
  name: string;
  trailName: string;
  direction: string;
  totalDays: number;
  totalKm: number;
  totalAscent: number;
  totalDescent: number;
}

function makePlan(overrides?: Partial<ExportPlan>): ExportPlan {
  return {
    name: 'Spring Thru-hike',
    trailName: 'Heysen Trail',
    direction: 'NOBO',
    totalDays: 3,
    totalKm: 75.5,
    totalAscent: 3200,
    totalDescent: 2800,
    ...overrides,
  };
}

function makeDay(overrides?: Partial<ComputedDay>): ComputedDay {
  return {
    dayNumber: 1,
    startName: 'Cape Jervis',
    endName: 'Tapanappa Campsite',
    startKm: 0,
    endKm: 25,
    distanceKm: 25,
    ascentM: 1100,
    descentM: 900,
    estimatedHours: 8,
    waterSources: 2,
    ...overrides,
  };
}

function makeDays(count: number, withDates?: boolean): ComputedDay[] {
  const days: ComputedDay[] = [];
  const names = [
    'Cape Jervis',
    'Tapanappa Campsite',
    'Deep Creek Camp',
    'Waitpinga Campsite',
  ];
  for (let i = 0; i < count; i++) {
    days.push(
      makeDay({
        dayNumber: i + 1,
        date: withDates ? `2026-04-${String(i + 1).padStart(2, '0')}` : undefined,
        startName: names[i] ?? `Stop ${i}`,
        endName: names[i + 1] ?? `Stop ${i + 1}`,
        startKm: i * 25,
        endKm: (i + 1) * 25,
        distanceKm: 25,
        ascentM: 1100 - i * 100,
        descentM: 900 + i * 50,
        estimatedHours: 8 - i,
        waterSources: 2 + i,
      }),
    );
  }
  return days;
}

function makeClimate(count: number): (DayClimate | null)[] {
  return Array.from({ length: count }, (_, i) => ({
    tempMin: 5 + i,
    tempMax: 18 + i,
    precipitation: 10 + i * 5,
    rainyDays: 3 + i,
  }));
}

// ---------------------------------------------------------------------------
// exportPlanAsText
// ---------------------------------------------------------------------------

describe('exportPlanAsText', () => {
  it('includes plan name, trail name, and direction', () => {
    const plan = makePlan();
    const days = makeDays(1);
    const text = exportPlanAsText(plan, days);

    expect(text).toContain('Spring Thru-hike');
    expect(text).toContain('Heysen Trail');
    expect(text).toContain('NOBO');
  });

  it('includes total stats (days, km, elevation)', () => {
    const plan = makePlan();
    const days = makeDays(1);
    const text = exportPlanAsText(plan, days);

    expect(text).toContain('3 days');
    expect(text).toContain('76 km');
    expect(text).toContain('+3200m');
    expect(text).toContain('-2800m');
  });

  it('includes date range when days have dates', () => {
    const plan = makePlan();
    const days = makeDays(3, true);
    const text = exportPlanAsText(plan, days);

    // formatDateShort produces en-AU style: "1 Apr 2026"
    expect(text).toContain('1 Apr 2026');
    expect(text).toContain('3 Apr 2026');
  });

  it('includes per-day breakdown with start/end names', () => {
    const plan = makePlan();
    const days = makeDays(3);
    const text = exportPlanAsText(plan, days);

    expect(text).toContain('Day 1');
    expect(text).toContain('Day 2');
    expect(text).toContain('Day 3');
    expect(text).toContain('Cape Jervis');
    expect(text).toContain('Tapanappa Campsite');
    expect(text).toContain('Deep Creek Camp');
    expect(text).toContain('Waitpinga Campsite');
    // Check arrow format
    expect(text).toMatch(/Cape Jervis .+ Tapanappa Campsite/);
  });

  it('includes climate data when provided', () => {
    const plan = makePlan();
    const days = makeDays(2);
    const climate = makeClimate(2);
    const text = exportPlanAsText(plan, days, climate);

    expect(text).toContain('Climate:');
    expect(text).toContain('5\u201318\u00B0C');
    expect(text).toContain('10mm rain');
    expect(text).toContain('6\u201319\u00B0C');
    expect(text).toContain('15mm rain');
  });

  it('omits dates when days have no dates', () => {
    const plan = makePlan();
    const days = makeDays(2, false);
    const text = exportPlanAsText(plan, days);

    // No date range line (no "Apr" or "2026" should appear)
    expect(text).not.toMatch(/\d{1,2} \w+ 2026 . \d{1,2} \w+ 2026/);
    // Per-day lines should not contain parenthesized dates
    expect(text).not.toMatch(/Day 1 \(/);
  });

  it('handles empty days array (no crash)', () => {
    const plan = makePlan();
    const text = exportPlanAsText(plan, []);

    expect(text).toContain('Spring Thru-hike');
    expect(text).toContain('Heysen Trail');
    // Should not contain any "Day" lines
    expect(text).not.toContain('Day 1');
  });
});

// ---------------------------------------------------------------------------
// exportPlanAsCsv
// ---------------------------------------------------------------------------

describe('exportPlanAsCsv', () => {
  it('has correct CSV headers', () => {
    const plan = makePlan();
    const days = makeDays(1);
    const csv = exportPlanAsCsv(plan, days);
    const headerLine = csv.split('\n')[0];

    expect(headerLine).toBe(
      'Day,Date,Start,End,Distance (km),Ascent (m),Descent (m),Est Hours,Water Sources',
    );
  });

  it('has one data row per day', () => {
    const plan = makePlan();
    const days = makeDays(3);
    const csv = exportPlanAsCsv(plan, days);
    const lines = csv.split('\n');

    // 1 header + 3 data rows
    expect(lines).toHaveLength(4);
  });

  it('escapes commas in field values', () => {
    const plan = makePlan();
    const days = [
      makeDay({
        startName: 'Town, with comma',
        endName: 'Normal End',
      }),
    ];
    const csv = exportPlanAsCsv(plan, days);
    const dataLine = csv.split('\n')[1];

    // "Town, with comma" should be wrapped in double quotes
    expect(dataLine).toContain('"Town, with comma"');
  });

  it('includes climate columns when climate data provided', () => {
    const plan = makePlan();
    const days = makeDays(2);
    const climate = makeClimate(2);
    const csv = exportPlanAsCsv(plan, days, climate);
    const lines = csv.split('\n');
    const headerLine = lines[0];

    expect(headerLine).toContain('Temp Min');
    expect(headerLine).toContain('Temp Max');
    expect(headerLine).toContain('Precipitation (mm)');
    expect(headerLine).toContain('Rainy Days');

    // Data row should include climate values
    const row1 = lines[1];
    expect(row1).toContain('5');
    expect(row1).toContain('18');
    expect(row1).toContain('10');
    expect(row1).toContain('3');
  });

  it('omits climate columns when no climate data', () => {
    const plan = makePlan();
    const days = makeDays(1);
    const csv = exportPlanAsCsv(plan, days);
    const headerLine = csv.split('\n')[0];

    expect(headerLine).not.toContain('Temp Min');
    expect(headerLine).not.toContain('Temp Max');
    expect(headerLine).not.toContain('Precipitation');
    expect(headerLine).not.toContain('Rainy Days');
  });

  it('handles empty days array', () => {
    const plan = makePlan();
    const csv = exportPlanAsCsv(plan, []);
    const lines = csv.split('\n');

    // Only the header line
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Day,Date,Start,End');
  });
});
