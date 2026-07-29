import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(async () => {
  // Apply every migration in migrations/ to the local test D1 in a setup file.
  const migrationsPath = path.join(dirname, 'migrations');
  const migrations = await readD1Migrations(migrationsPath);

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          // Test-only bindings: migrations array for the setup file, plus a
          // deterministic public base so photo-URL assertions don't depend on
          // the production r2.dev host.
          bindings: {
            TEST_MIGRATIONS: migrations,
            PHOTOS_PUBLIC_BASE: 'https://photos.test',
          },
          // Local R2 bucket backing the PHOTOS binding (wrangler.toml declares
          // the binding; this provisions its miniflare-local store for tests).
          r2Buckets: { PHOTOS: 'aus-map-data' },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/apply-migrations.ts'],
    },
  };
});
