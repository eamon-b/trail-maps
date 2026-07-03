import { generateId, migrateStopsJson } from '../plan-utils';

// ---------------------------------------------------------------------------
// generateId
// ---------------------------------------------------------------------------

describe('generateId', () => {
  it('returns a non-empty string', () => {
    const id = generateId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('returns unique values on repeated calls', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateId()));
    expect(ids.size).toBe(50);
  });

  describe('when crypto.randomUUID is unavailable', () => {
    let originalRandomUUID: typeof globalThis.crypto.randomUUID;

    beforeEach(() => {
      originalRandomUUID = globalThis.crypto.randomUUID;
      (globalThis.crypto as unknown as Record<string, unknown>).randomUUID = undefined;
    });

    afterEach(() => {
      globalThis.crypto.randomUUID = originalRandomUUID;
    });

    it('falls back to a 16-character hex string', () => {
      const id = generateId();
      expect(id).toMatch(/^[0-9a-f]{16}$/);
    });
  });
});

// ---------------------------------------------------------------------------
// migrateStopsJson
// ---------------------------------------------------------------------------

describe('migrateStopsJson', () => {
  it('returns empty array for null input', () => {
    expect(migrateStopsJson(null)).toEqual([]);
  });

  it('preserves existing fields', () => {
    const input = JSON.stringify([
      {
        id: 'abc',
        waypointName: 'Camp A',
        waypointType: 'campsite',
        km: 10,
        notes: 'nice spot',
      },
    ]);
    const result = migrateStopsJson(input);
    expect(result).toHaveLength(1);
    expect(result[0].waypointType).toBe('campsite');
    expect(result[0].km).toBe(10);
    expect(result[0].notes).toBe('nice spot');
  });

  it('backfills missing id with a generated value', () => {
    const input = JSON.stringify([
      { waypointName: 'Camp A', waypointType: 'campsite', km: 10 },
    ]);
    const result = migrateStopsJson(input);
    expect(result[0].id).toBeDefined();
    expect(typeof result[0].id).toBe('string');
    expect(result[0].id.length).toBeGreaterThan(0);
  });

  it('backfills missing waypointName to null', () => {
    const input = JSON.stringify([
      { id: 'abc', waypointType: 'campsite', km: 10 },
    ]);
    const result = migrateStopsJson(input);
    expect(result[0].waypointName).toBeNull();
  });

  it('preserves existing id and waypointName', () => {
    const input = JSON.stringify([
      { id: 'keep-me', waypointName: 'Camp B', waypointType: 'hut', km: 25 },
    ]);
    const result = migrateStopsJson(input);
    expect(result[0].id).toBe('keep-me');
    expect(result[0].waypointName).toBe('Camp B');
  });

  it('throws on invalid JSON', () => {
    expect(() => migrateStopsJson('not valid json')).toThrow();
  });
});
