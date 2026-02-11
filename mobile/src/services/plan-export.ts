/**
 * Plan export — text and CSV formats for sharing hiking plans.
 */

import type { ComputedDay } from './plan-calculator-types';
import type { DayClimate } from './climate-service';

interface ExportPlan {
  name: string;
  trailName: string;
  direction: string;
  totalDays: number;
  totalKm: number;
  totalAscent: number;
  totalDescent: number;
}

/**
 * Export plan as human-readable text.
 */
export function exportPlanAsText(
  plan: ExportPlan,
  days: ComputedDay[],
  climate?: (DayClimate | null)[],
): string {
  const lines: string[] = [];

  lines.push(`${plan.name} — ${plan.trailName} (${plan.direction})`);
  lines.push(`${plan.totalDays} days · ${Math.round(plan.totalKm)} km · +${Math.round(plan.totalAscent)}m / -${Math.round(plan.totalDescent)}m`);

  const firstDate = days[0]?.date;
  const lastDate = days[days.length - 1]?.date;
  if (firstDate && lastDate) {
    lines.push(`${formatDateShort(firstDate)} – ${formatDateShort(lastDate)}`);
  }

  lines.push('');

  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const dateStr = day.date ? ` (${formatDateShort(day.date)})` : '';
    lines.push(`Day ${day.dayNumber}${dateStr} — ${day.startName} → ${day.endName}`);
    lines.push(`  ${day.distanceKm.toFixed(1)} km · +${day.ascentM}m / -${day.descentM}m · ~${day.estimatedHours}h · ${day.waterSources} water source${day.waterSources !== 1 ? 's' : ''}`);

    if (climate?.[i]) {
      const c = climate[i]!;
      lines.push(`  Climate: ${c.tempMin}–${c.tempMax}°C, ${c.precipitation}mm rain`);
    }

    lines.push('');
  }

  return lines.join('\n').trim();
}

/**
 * Export plan as CSV.
 */
export function exportPlanAsCsv(
  plan: ExportPlan,
  days: ComputedDay[],
  climate?: (DayClimate | null)[],
): string {
  const headers = [
    'Day', 'Date', 'Start', 'End',
    'Distance (km)', 'Ascent (m)', 'Descent (m)',
    'Est Hours', 'Water Sources',
  ];

  if (climate) {
    headers.push('Temp Min (°C)', 'Temp Max (°C)', 'Precipitation (mm)', 'Rainy Days');
  }

  const rows = [headers.join(',')];

  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const fields: string[] = [
      String(day.dayNumber),
      day.date ?? '',
      csvEscape(day.startName),
      csvEscape(day.endName),
      day.distanceKm.toFixed(1),
      String(day.ascentM),
      String(day.descentM),
      String(day.estimatedHours),
      String(day.waterSources),
    ];

    if (climate) {
      const c = climate[i];
      fields.push(
        c ? String(c.tempMin) : '',
        c ? String(c.tempMax) : '',
        c ? String(c.precipitation) : '',
        c ? String(c.rainyDays) : '',
      );
    }

    rows.push(fields.join(','));
  }

  return rows.join('\n');
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function formatDateShort(iso: string): string {
  const d = new Date(iso + 'T12:00:00Z');
  return d.toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
