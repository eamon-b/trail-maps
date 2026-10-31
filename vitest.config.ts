import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: [
            'src/lib/**/*.{test,spec}.{js,ts}',
            'scripts/**/*.{test,spec}.{js,ts}',
            'contours/scripts/**/*.{test,spec}.{js,ts}',
          ],
        },
      },
      {
        // The jsdom page suites boot the real HTML and its modules fresh for
        // each test (`vi.resetModules()`), and several ingest a real GPX through
        // the page. That is ~0.5-1 s of CPU per test, so under load (the mobile
        // Jest suite in parallel, a busy CI runner) Vitest's 5 s default failed
        // whichever ones were slowest that run (#251). The headroom is for load;
        // a test that needs it on an idle machine has regressed.
        extends: true,
        test: {
          name: 'pages',
          include: ['src/web/**/*.{test,spec}.{js,ts}'],
          testTimeout: 20_000,
        },
      },
    ],
  },
  resolve: {
    alias: {
      '@lib': resolve(__dirname, 'src/lib'),
    },
  },
});
