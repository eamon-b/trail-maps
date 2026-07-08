import { createMigratedTestDb, expectDbRejection } from '../../../db/__tests__/test-helpers';
import { PlanService } from '../../plan-service';
import type { TestDatabase } from '../../../db/__tests__/sqlite-test-adapter';

// Mock plan-utils generateId to return predictable values in version tests
jest.mock('../../plan-utils', () => {
  let counter = 0;
  return {
    generateId: () => `test-id-${++counter}`,
  };
});

describe('PlanService integration', () => {
  let db: TestDatabase;
  let service: PlanService;

  beforeEach(async () => {
    db = await createMigratedTestDb();
    service = new PlanService(db as any);

    // Insert a trail (FK requirement for plans)
    await db.runAsync(
      'INSERT INTO trails (id, name) VALUES (?, ?)',
      ['heysen', 'Heysen Trail']
    );
  });

  afterEach(async () => {
    await db.closeAsync();
  });

  it('creates and retrieves a plan', async () => {
    await service.createPlan({
      id: 'plan-1',
      trailId: 'heysen',
      name: 'My Hike',
      direction: 'NOBO',
      startDate: '2026-04-01',
      sectionJson: null,
      stopsJson: '[]',
    });

    const plan = await service.getPlan('plan-1');
    expect(plan).not.toBeNull();
    expect(plan!.id).toBe('plan-1');
    expect(plan!.trailId).toBe('heysen');
    expect(plan!.name).toBe('My Hike');
    expect(plan!.direction).toBe('NOBO');
    expect(plan!.startDate).toBe('2026-04-01');
    expect(plan!.stopsJson).toBe('[]');
  });

  it('lists plans by trail, ordered by updated_at DESC', async () => {
    await service.createPlan({
      id: 'plan-1',
      trailId: 'heysen',
      name: 'First Plan',
      direction: 'NOBO',
      startDate: null,
      sectionJson: null,
      stopsJson: null,
    });

    // Small delay to ensure different timestamps
    await db.runAsync(
      "UPDATE plans SET updated_at = datetime('now', '-1 second') WHERE id = ?",
      ['plan-1']
    );

    await service.createPlan({
      id: 'plan-2',
      trailId: 'heysen',
      name: 'Second Plan',
      direction: 'SOBO',
      startDate: null,
      sectionJson: null,
      stopsJson: null,
    });

    const plans = await service.listPlansForTrail('heysen');
    expect(plans).toHaveLength(2);
    // Most recently updated first
    expect(plans[0].name).toBe('Second Plan');
    expect(plans[1].name).toBe('First Plan');
  });

  it('updates specific plan fields', async () => {
    await service.createPlan({
      id: 'plan-1',
      trailId: 'heysen',
      name: 'Original',
      direction: 'NOBO',
      startDate: null,
      sectionJson: null,
      stopsJson: null,
    });

    await service.updatePlan('plan-1', {
      name: 'Updated Name',
      direction: 'SOBO',
      stopsJson: '[{"km":10}]',
    });

    const plan = await service.getPlan('plan-1');
    expect(plan!.name).toBe('Updated Name');
    expect(plan!.direction).toBe('SOBO');
    expect(plan!.stopsJson).toBe('[{"km":10}]');
  });

  it('deletes a plan', async () => {
    await service.createPlan({
      id: 'plan-1',
      trailId: 'heysen',
      name: 'To Delete',
      direction: 'NOBO',
      startDate: null,
      sectionJson: null,
      stopsJson: null,
    });

    await service.deletePlan('plan-1');

    const plan = await service.getPlan('plan-1');
    expect(plan).toBeNull();
  });

  it('gets active (most recent) plan for trail', async () => {
    await service.createPlan({
      id: 'plan-1',
      trailId: 'heysen',
      name: 'Old Plan',
      direction: 'NOBO',
      startDate: null,
      sectionJson: null,
      stopsJson: null,
    });

    await db.runAsync(
      "UPDATE plans SET updated_at = datetime('now', '-1 hour') WHERE id = ?",
      ['plan-1']
    );

    await service.createPlan({
      id: 'plan-2',
      trailId: 'heysen',
      name: 'Active Plan',
      direction: 'SOBO',
      startDate: null,
      sectionJson: null,
      stopsJson: null,
    });

    const active = await service.getActivePlanForTrail('heysen');
    expect(active).not.toBeNull();
    expect(active!.name).toBe('Active Plan');
  });

  it('saves plan version snapshot', async () => {
    await service.createPlan({
      id: 'plan-1',
      trailId: 'heysen',
      name: 'My Plan',
      direction: 'NOBO',
      startDate: '2026-04-01',
      sectionJson: null,
      stopsJson: '[{"km":10}]',
    });

    const versionId = await service.savePlanVersion('plan-1', 'Snapshot 1');
    expect(versionId).toBeDefined();
    expect(typeof versionId).toBe('string');
  });

  it('lists plan versions newest first', async () => {
    await service.createPlan({
      id: 'plan-1',
      trailId: 'heysen',
      name: 'My Plan',
      direction: 'NOBO',
      startDate: null,
      sectionJson: null,
      stopsJson: '[{"km":10}]',
    });

    const v1Id = await service.savePlanVersion('plan-1', 'V1');

    // Backdate V1 so V2 is definitively newer
    await db.runAsync(
      "UPDATE plan_versions SET created_at = datetime('now', '-1 minute') WHERE id = ?",
      [v1Id]
    );

    // Update plan and save another version
    await service.updatePlan('plan-1', { stopsJson: '[{"km":20}]' });
    await service.savePlanVersion('plan-1', 'V2');

    const versions = await service.listPlanVersions('plan-1');
    expect(versions).toHaveLength(2);
    // Newest first
    expect(versions[0].name).toBe('V2');
    expect(versions[1].name).toBe('V1');
  });

  it('loads plan version (restores state)', async () => {
    await service.createPlan({
      id: 'plan-1',
      trailId: 'heysen',
      name: 'My Plan',
      direction: 'NOBO',
      startDate: '2026-04-01',
      sectionJson: null,
      stopsJson: '[{"km":10}]',
    });

    const versionId = await service.savePlanVersion('plan-1', 'Before change');

    // Change the plan
    await service.updatePlan('plan-1', {
      direction: 'SOBO',
      stopsJson: '[{"km":99}]',
    });

    // Restore the version
    await service.loadPlanVersion('plan-1', versionId);

    const plan = await service.getPlan('plan-1');
    expect(plan!.direction).toBe('NOBO');
    expect(plan!.stopsJson).toBe('[{"km":10}]');
  });

  it('deletes plan version', async () => {
    await service.createPlan({
      id: 'plan-1',
      trailId: 'heysen',
      name: 'My Plan',
      direction: 'NOBO',
      startDate: null,
      sectionJson: null,
      stopsJson: null,
    });

    const versionId = await service.savePlanVersion('plan-1', 'To Delete');

    await service.deletePlanVersion(versionId);

    const versions = await service.listPlanVersions('plan-1');
    expect(versions).toHaveLength(0);
  });

  it('cascade: deleting plan removes versions', async () => {
    await service.createPlan({
      id: 'plan-1',
      trailId: 'heysen',
      name: 'My Plan',
      direction: 'NOBO',
      startDate: null,
      sectionJson: null,
      stopsJson: null,
    });

    await service.savePlanVersion('plan-1', 'V1');
    await service.savePlanVersion('plan-1', 'V2');

    await service.deletePlan('plan-1');

    const versions = await service.listPlanVersions('plan-1');
    expect(versions).toHaveLength(0);
  });

  it('rejects plan with non-existent trail_id', async () => {
    await expectDbRejection(() =>
      service.createPlan({
        id: 'plan-bad',
        trailId: 'nonexistent',
        name: 'Bad Plan',
        direction: 'NOBO',
        startDate: null,
        sectionJson: null,
        stopsJson: null,
      })
    );
  });
});
