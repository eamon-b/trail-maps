import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  applyCuratedDescriptions,
  DESCRIPTIONS_FILENAME,
  MAX_DESCRIPTION_LENGTH,
  loadCuratedDescriptions,
  parseCuratedDescriptions,
} from './waypoint-descriptions';
import type { WaypointRegistry } from './waypoint-ids';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const TRAILS_DIR = path.join(PROJECT_ROOT, 'data', 'trails');
const REGISTRY_PATH = path.join(PROJECT_ROOT, 'data', 'waypoint-ids.json');

function validFile(overrides: Record<string, unknown> = {}) {
  return {
    trailId: 'demo',
    descriptions: [{ waypointId: 'w_abcd1234', name: 'Hut', description: 'A hut.' }],
    ...overrides,
  };
}

describe('parseCuratedDescriptions', () => {
  it('accepts a well-formed file and trims the text', () => {
    const entries = parseCuratedDescriptions(
      validFile({ descriptions: [{ waypointId: 'w_abcd1234', description: '  A hut.  ' }] }),
      'demo',
      'test.json'
    );
    expect(entries).toEqual([{ waypointId: 'w_abcd1234', description: 'A hut.' }]);
  });

  it('keeps the optional name for reviewability', () => {
    const entries = parseCuratedDescriptions(validFile(), 'demo', 'test.json');
    expect(entries[0].name).toBe('Hut');
  });

  it('rejects a trailId that does not match the trail directory', () => {
    expect(() => parseCuratedDescriptions(validFile({ trailId: 'other' }), 'demo', 'test.json')).toThrow(
      /trailId/
    );
  });

  it('rejects a malformed waypoint id', () => {
    const file = validFile({ descriptions: [{ waypointId: 'Bad Id!', description: 'x' }] });
    expect(() => parseCuratedDescriptions(file, 'demo', 'test.json')).toThrow(/waypointId/);
  });

  it('rejects duplicate waypoint ids', () => {
    const file = validFile({
      descriptions: [
        { waypointId: 'w_abcd1234', description: 'first' },
        { waypointId: 'w_abcd1234', description: 'second' },
      ],
    });
    expect(() => parseCuratedDescriptions(file, 'demo', 'test.json')).toThrow(/repeats/);
  });

  it('rejects an empty description rather than bundling a blank', () => {
    const file = validFile({ descriptions: [{ waypointId: 'w_abcd1234', description: '   ' }] });
    expect(() => parseCuratedDescriptions(file, 'demo', 'test.json')).toThrow(/empty/);
  });

  it('rejects a description longer than the API accepts', () => {
    const file = validFile({
      descriptions: [{ waypointId: 'w_abcd1234', description: 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1) }],
    });
    expect(() => parseCuratedDescriptions(file, 'demo', 'test.json')).toThrow(/caps descriptions/);
  });

  it('rejects a missing descriptions array', () => {
    expect(() => parseCuratedDescriptions({ trailId: 'demo' }, 'demo', 'test.json')).toThrow(
      /descriptions/
    );
  });
});

describe('applyCuratedDescriptions', () => {
  it('overwrites source descriptions and reports unmatched ids', () => {
    const waypoints = [
      { id: 'w_aaaa1111', description: 'With general store and caravan park.' },
      { id: 'w_bbbb2222' },
      { description: 'no id at all' },
    ];

    const result = applyCuratedDescriptions(waypoints, [
      { waypointId: 'w_aaaa1111', description: 'Curated town blurb.' },
      { waypointId: 'w_cccc3333', description: 'Stale entry.' },
    ]);

    expect(waypoints[0].description).toBe('Curated town blurb.');
    expect(waypoints[1].description).toBeUndefined();
    expect(waypoints[2].description).toBe('no id at all');
    expect(result.applied).toBe(1);
    expect(result.unmatchedIds).toEqual(['w_cccc3333']);
  });

  it('is a no-op for a trail with no curated content', () => {
    const waypoints = [{ id: 'w_aaaa1111', description: 'source text' }];
    expect(applyCuratedDescriptions(waypoints, [])).toEqual({ applied: 0, unmatchedIds: [] });
    expect(waypoints[0].description).toBe('source text');
  });
});

describe('loadCuratedDescriptions', () => {
  it('returns nothing for a trail directory without a descriptions file', () => {
    expect(loadCuratedDescriptions(path.join(TRAILS_DIR, 'no-such-trail'), 'no-such-trail')).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// The committed content itself. These guard the authored files, not the code:
// a stale id here means prose that silently never reaches a phone.
// --------------------------------------------------------------------------

const registry: WaypointRegistry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));

// A trail's directory name is not its build id: `AAWT` builds `aawt` and
// `Hume_and_Hovell` builds `hume-and-hovell`. Both the loader's trailId check
// and the registry are keyed by the build id, so read it from trail.json
// rather than assuming the directory name (which only matched while every
// authored trail happened to have a lowercase directory).
const trailsWithDescriptions = fs
  .readdirSync(TRAILS_DIR, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .filter(name => fs.existsSync(path.join(TRAILS_DIR, name, DESCRIPTIONS_FILENAME)))
  .map(dir => {
    const config = JSON.parse(
      fs.readFileSync(path.join(TRAILS_DIR, dir, 'trail.json'), 'utf-8')
    ) as { id?: string };
    if (typeof config.id !== 'string' || config.id.length === 0) {
      throw new Error(`data/trails/${dir}/trail.json has no "id"`);
    }
    return { dir, trailId: config.id };
  })
  .sort((a, b) => a.trailId.localeCompare(b.trailId));

describe('committed descriptions.json files', () => {
  it('includes the Cape to Cape first pass', () => {
    expect(trailsWithDescriptions.map(entry => entry.trailId)).toContain('cape_to_cape');
  });

  it.each(trailsWithDescriptions)('$trailId parses and every id is in the registry', ({ dir, trailId }) => {
    const entries = loadCuratedDescriptions(path.join(TRAILS_DIR, dir), trailId);
    expect(entries.length).toBeGreaterThan(0);

    const knownIds = new Set((registry[trailId] ?? []).map(entry => entry.id));
    const unknown = entries.filter(entry => !knownIds.has(entry.waypointId));
    expect(unknown.map(entry => `${entry.waypointId} (${entry.name ?? '?'})`)).toEqual([]);
  });

  it.each(trailsWithDescriptions)('$trailId stays plain text and reasonably short', ({ dir, trailId }) => {
    const entries = loadCuratedDescriptions(path.join(TRAILS_DIR, dir), trailId);
    for (const entry of entries) {
      // Rendered as plain text on mobile and HTML-escaped on the web; markup
      // here would show up literally in both places.
      expect(entry.description).not.toMatch(/[<>]/);
      // House style is 1-3 sentences. Generous ceiling, but it catches an
      // essay pasted in by accident.
      expect(entry.description.length).toBeLessThanOrEqual(400);
    }
  });
});
