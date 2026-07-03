/**
 * Guards against drift between the canonical map style and the bundled copy.
 *
 * scripts/topo-style.json is the single source of truth. The mobile app
 * bundles a copy at mobile/assets/topo-style.json (Metro can't require files
 * outside the project root at runtime). Run `npm run sync:style` from the
 * repo root after editing the canonical style.
 */

import * as fs from 'fs';
import * as path from 'path';

const CANONICAL_PATH = path.resolve(__dirname, '../../../../scripts/topo-style.json');
const BUNDLED_PATH = path.resolve(__dirname, '../../../assets/topo-style.json');

describe('topo-style.json sync', () => {
  it('bundled mobile copy matches canonical scripts/topo-style.json', () => {
    const canonical = JSON.parse(fs.readFileSync(CANONICAL_PATH, 'utf-8'));
    const bundled = JSON.parse(fs.readFileSync(BUNDLED_PATH, 'utf-8'));

    expect(bundled).toEqual(canonical);
  });
});
