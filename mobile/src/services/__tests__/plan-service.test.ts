import { PlanService } from '../plan-service';

function createMockDb() {
  return {
    runAsync: jest.fn().mockResolvedValue({ changes: 1, lastInsertRowId: 1 }),
    getFirstAsync: jest.fn().mockResolvedValue(null),
    getAllAsync: jest.fn().mockResolvedValue([]),
    execAsync: jest.fn().mockResolvedValue(undefined),
    closeAsync: jest.fn().mockResolvedValue(undefined),
  };
}

describe('PlanService', () => {
  let service: PlanService;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    service = new PlanService(mockDb as any);
  });

  it('creates a new plan', async () => {
    await service.createPlan({
      id: 'plan-1',
      trailId: 'bibbulmum',
      name: 'April Thru-hike',
      direction: 'NOBO',
      startDate: '2026-04-01',
      sectionJson: null,
      stopsJson: JSON.stringify(['campsite-1', 'campsite-2']),
    });

    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO plans'),
      expect.arrayContaining(['plan-1', 'bibbulmum', 'April Thru-hike']),
    );
  });

  it('retrieves a plan by id', async () => {
    mockDb.getFirstAsync.mockResolvedValueOnce({
      id: 'plan-1',
      trail_id: 'bibbulmum',
      name: 'April Thru-hike',
      direction: 'NOBO',
      start_date: '2026-04-01',
      section_json: null,
      stops_json: '["campsite-1"]',
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    });

    const plan = await service.getPlan('plan-1');
    expect(plan).not.toBeNull();
    expect(plan!.name).toBe('April Thru-hike');
    expect(plan!.trailId).toBe('bibbulmum');
    expect(plan!.direction).toBe('NOBO');
  });

  it('returns null for unknown plan', async () => {
    const plan = await service.getPlan('nonexistent');
    expect(plan).toBeNull();
  });

  it('lists plans for a trail', async () => {
    mockDb.getAllAsync.mockResolvedValueOnce([
      { id: 'plan-1', trail_id: 'bibbulmum', name: 'Plan A', direction: 'NOBO', start_date: null, section_json: null, stops_json: null, created_at: '2026-01-01', updated_at: '2026-01-02' },
      { id: 'plan-2', trail_id: 'bibbulmum', name: 'Plan B', direction: 'SOBO', start_date: null, section_json: null, stops_json: null, created_at: '2026-01-01', updated_at: '2026-01-01' },
    ]);

    const plans = await service.listPlansForTrail('bibbulmum');
    expect(plans).toHaveLength(2);
    expect(plans[0].name).toBe('Plan A');
  });

  it('updates a plan', async () => {
    await service.updatePlan('plan-1', { name: 'Updated Name', direction: 'SOBO' });

    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE plans SET'),
      expect.arrayContaining(['Updated Name', 'SOBO', 'plan-1']),
    );
  });

  it('does nothing when updating with no fields', async () => {
    await service.updatePlan('plan-1', {});
    expect(mockDb.runAsync).not.toHaveBeenCalled();
  });

  it('deletes a plan', async () => {
    await service.deletePlan('plan-1');
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      'DELETE FROM plans WHERE id = ?',
      ['plan-1'],
    );
  });
});
