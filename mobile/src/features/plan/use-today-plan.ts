/**
 * Today's plan for the open guide — the hook over `today-plan.ts`.
 *
 * Reads the plan at a glance (`use-plan-glance`: the saved plan's days over the
 * route it walks) and picks out the day dated today. The date is the phone's
 * local one, re-read whenever the app comes back to the foreground, so a guide
 * left open overnight moves on to the next day.
 */

import { useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import type { TrailJson } from '../../services/trail-assets';
import { localIsoDate, todayPlan, todayRows, type TodayPlan, type TodayRow } from './today-plan';
import { usePlanGlance } from './use-plan-glance';

export interface TodayPlanState {
  /** Today's day of the plan, or null when the plan has none for today. */
  today: TodayPlan | null;
  /** The walking day's rows; empty on a rest day or with no plan for today. */
  rows: TodayRow[];
  /** Today's date, `YYYY-MM-DD`. */
  date: string;
  /** The route the rows are measured on. */
  trail: TrailJson;
  /** False until the plan has a start date — without one no day has a date. */
  hasStartDate: boolean;
  /** False until the plan has a stop. */
  hasStops: boolean;
}

/** The local date, refreshed on every return to the foreground. */
export function useLocalDate(): string {
  const [date, setDate] = useState(() => localIsoDate(new Date()));
  useEffect(() => {
    const sub = AppState.addEventListener('change', (status) => {
      if (status === 'active') setDate(localIsoDate(new Date()));
    });
    return () => sub.remove();
  }, []);
  return date;
}

export function useTodayPlan(): TodayPlanState {
  const glance = usePlanGlance();
  const date = useLocalDate();
  return useMemo(() => {
    const today = todayPlan(glance, date);
    return {
      today,
      rows: today?.kind === 'walk' ? todayRows(glance.trail, today.day) : [],
      date,
      trail: glance.trail,
      hasStartDate: glance.plan.startDate !== null,
      hasStops: glance.hasStops,
    };
  }, [glance, date]);
}
