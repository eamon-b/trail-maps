import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabase } from '../db/database';
import { generateId } from './plan-utils';

export interface PlanVersion {
  id: string;
  planId: string;
  name: string | null;
  stopsJson: string | null;
  sectionJson: string | null;
  direction: string | null;
  startDate: string | null;
  createdAt: string;
}

interface PlanVersionRow {
  id: string;
  plan_id: string;
  name: string | null;
  stops_json: string | null;
  section_json: string | null;
  direction: string | null;
  start_date: string | null;
  created_at: string;
}

function rowToVersion(row: PlanVersionRow): PlanVersion {
  return {
    id: row.id,
    planId: row.plan_id,
    name: row.name,
    stopsJson: row.stops_json,
    sectionJson: row.section_json,
    direction: row.direction,
    startDate: row.start_date,
    createdAt: row.created_at,
  };
}

export interface Plan {
  id: string;
  trailId: string;
  name: string;
  direction: string;
  startDate: string | null;
  sectionJson: string | null;
  stopsJson: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PlanRow {
  id: string;
  trail_id: string;
  name: string;
  direction: string;
  start_date: string | null;
  section_json: string | null;
  stops_json: string | null;
  created_at: string;
  updated_at: string;
}

function rowToPlan(row: PlanRow): Plan {
  return {
    id: row.id,
    trailId: row.trail_id,
    name: row.name,
    direction: row.direction,
    startDate: row.start_date,
    sectionJson: row.section_json,
    stopsJson: row.stops_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PlanService {
  constructor(private db: SQLiteDatabase) {}

  static async create(): Promise<PlanService> {
    const db = await getDatabase();
    return new PlanService(db);
  }

  async createPlan(plan: Omit<Plan, 'createdAt' | 'updatedAt'>): Promise<void> {
    await this.db.runAsync(
      `INSERT INTO plans (id, trail_id, name, direction, start_date, section_json, stops_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [plan.id, plan.trailId, plan.name, plan.direction, plan.startDate, plan.sectionJson, plan.stopsJson]
    );
  }

  async getPlan(id: string): Promise<Plan | null> {
    const row = await this.db.getFirstAsync<PlanRow>(
      'SELECT * FROM plans WHERE id = ?',
      [id]
    );
    return row ? rowToPlan(row) : null;
  }

  async listPlansForTrail(trailId: string): Promise<Plan[]> {
    const rows = await this.db.getAllAsync<PlanRow>(
      'SELECT * FROM plans WHERE trail_id = ? ORDER BY updated_at DESC',
      [trailId]
    );
    return rows.map(rowToPlan);
  }

  async updatePlan(id: string, updates: Partial<Pick<Plan, 'name' | 'direction' | 'startDate' | 'sectionJson' | 'stopsJson'>>): Promise<void> {
    const sets: string[] = [];
    const values: (string | null)[] = [];

    if (updates.name !== undefined) { sets.push('name = ?'); values.push(updates.name); }
    if (updates.direction !== undefined) { sets.push('direction = ?'); values.push(updates.direction); }
    if (updates.startDate !== undefined) { sets.push('start_date = ?'); values.push(updates.startDate); }
    if (updates.sectionJson !== undefined) { sets.push('section_json = ?'); values.push(updates.sectionJson); }
    if (updates.stopsJson !== undefined) { sets.push('stops_json = ?'); values.push(updates.stopsJson); }

    if (sets.length === 0) return;

    sets.push("updated_at = datetime('now')");
    values.push(id);

    await this.db.runAsync(
      `UPDATE plans SET ${sets.join(', ')} WHERE id = ?`,
      values
    );
  }

  async deletePlan(id: string): Promise<void> {
    await this.db.runAsync('DELETE FROM plans WHERE id = ?', [id]);
  }

  /** Get the most recently updated plan for a trail (the "active" plan). */
  async getActivePlanForTrail(trailId: string): Promise<Plan | null> {
    const row = await this.db.getFirstAsync<PlanRow>(
      'SELECT * FROM plans WHERE trail_id = ? ORDER BY updated_at DESC LIMIT 1',
      [trailId]
    );
    return row ? rowToPlan(row) : null;
  }

  /** Save a snapshot of the current plan state as a named version. */
  async savePlanVersion(planId: string, name?: string): Promise<string> {
    const plan = await this.getPlan(planId);
    if (!plan) throw new Error(`Plan ${planId} not found`);

    const versionId = generateId();
    await this.db.runAsync(
      `INSERT INTO plan_versions (id, plan_id, name, stops_json, section_json, direction, start_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [versionId, planId, name ?? null, plan.stopsJson, plan.sectionJson, plan.direction, plan.startDate]
    );
    return versionId;
  }

  /** List all saved versions for a plan, newest first. */
  async listPlanVersions(planId: string): Promise<PlanVersion[]> {
    const rows = await this.db.getAllAsync<PlanVersionRow>(
      'SELECT * FROM plan_versions WHERE plan_id = ? ORDER BY created_at DESC',
      [planId]
    );
    return rows.map(rowToVersion);
  }

  /** Restore a saved version into the plan. */
  async loadPlanVersion(planId: string, versionId: string): Promise<void> {
    const row = await this.db.getFirstAsync<PlanVersionRow>(
      'SELECT * FROM plan_versions WHERE id = ? AND plan_id = ?',
      [versionId, planId]
    );
    if (!row) throw new Error(`Version ${versionId} not found`);

    const updates: Partial<Pick<Plan, 'stopsJson' | 'sectionJson' | 'direction' | 'startDate'>> = {};
    if (row.stops_json !== null) updates.stopsJson = row.stops_json;
    if (row.section_json !== null) updates.sectionJson = row.section_json;
    if (row.direction !== null) updates.direction = row.direction;
    if (row.start_date !== null) updates.startDate = row.start_date;

    await this.updatePlan(planId, updates);
  }

  /** Delete a saved version. */
  async deletePlanVersion(versionId: string): Promise<void> {
    await this.db.runAsync('DELETE FROM plan_versions WHERE id = ?', [versionId]);
  }
}

