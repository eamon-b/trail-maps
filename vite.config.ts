import { defineConfig } from 'vite';
import { resolve } from 'path';
import { readdirSync, existsSync, statSync } from 'fs';

// Dynamically find all trail page directories (index.html and climate.html)
function getTrailInputs(): Record<string, string> {
  const trailsDir = resolve(__dirname, 'src/web/trails');
  const inputs: Record<string, string> = {};

  if (!existsSync(trailsDir)) return inputs;

  const entries = readdirSync(trailsDir);
  for (const entry of entries) {
    const entryPath = resolve(trailsDir, entry);
    if (statSync(entryPath).isDirectory()) {
      // Add index.html if it exists
      const indexPath = resolve(entryPath, 'index.html');
      if (existsSync(indexPath)) {
        inputs[`trail-${entry}`] = indexPath;
      }
      // Add climate.html if it exists
      const climatePath = resolve(entryPath, 'climate.html');
      if (existsSync(climatePath)) {
        inputs[`trail-${entry}-climate`] = climatePath;
      }
      // Add plan.html if it exists
      const planPath = resolve(entryPath, 'plan.html');
      if (existsSync(planPath)) {
        inputs[`trail-${entry}-plan`] = planPath;
      }
    }
  }

  return inputs;
}

export default defineConfig({
  root: 'src/web',
  base: './',
  publicDir: '../../public',
  server: {
    fs: {
      // Allow serving files from the data directory
      allow: ['../..'],
    },
  },
  plugins: [],
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/web/index.html'),
        // Dynamically include all generated trail pages
        ...getTrailInputs(),
      },
    },
  },
  resolve: {
    alias: {
      '@lib': resolve(__dirname, 'src/lib'),
    },
  },
});
