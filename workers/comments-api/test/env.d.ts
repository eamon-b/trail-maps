/// <reference path="../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />

import type { D1Migration } from '@cloudflare/vitest-pool-workers';

// Augment the worker's environment with the bindings our tests rely on: the D1
// database (from wrangler.toml) and the test-only migrations array injected by
// vitest.config.ts.
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      PHOTOS: R2Bucket;
      PHOTOS_PUBLIC_BASE: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
