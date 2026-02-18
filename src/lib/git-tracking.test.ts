import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { readdirSync } from 'fs';
import { join } from 'path';

/**
 * Regression test: ensures all TypeScript source files in src/ are tracked by git.
 *
 * A global gitignore rule (`lib/`) previously caused new files added to src/lib/
 * to be silently ignored, leading to Vercel build failures (TS2307: Cannot find module).
 * Local builds passed because the files existed on disk even though they weren't committed.
 */
describe('git tracking', () => {
  it('should not have any gitignored .ts files in src/lib/', () => {
    const libDir = join(__dirname);
    const tsFiles = readdirSync(libDir).filter(f => f.endsWith('.ts'));

    const ignored: string[] = [];
    for (const file of tsFiles) {
      const filePath = join(libDir, file);
      try {
        // git check-ignore exits 0 if the file IS ignored, 1 if it is NOT ignored
        execSync(`git check-ignore -q "${filePath}"`, { stdio: 'pipe' });
        ignored.push(file);
      } catch {
        // exit code 1 = not ignored, which is what we want
      }
    }

    expect(ignored, `These src/lib/ files are gitignored and will be missing from Vercel builds: ${ignored.join(', ')}`).toEqual([]);
  });
});
