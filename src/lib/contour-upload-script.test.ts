import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';

const PROJECT_ROOT = resolve(__dirname, '../..');
const UPLOAD_SCRIPT = resolve(PROJECT_ROOT, 'scripts/upload-tiles.sh');

describe('Australia contour upload contract', () => {
  let tempRoot: string;
  let tilesDir: string;
  let binDir: string;
  let commandLog: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'contour-upload-test-'));
    tilesDir = join(tempRoot, 'tiles');
    binDir = join(tempRoot, 'bin');
    commandLog = join(tempRoot, 'commands.log');
    mkdirSync(tilesDir);
    mkdirSync(binDir);

    // Small but structurally valid PMTiles v3 header for script-level tests.
    writeFileSync(
      join(tilesDir, 'australia-contours.pmtiles'),
      Buffer.concat([Buffer.from('PMTiles'), Buffer.from([3]), Buffer.from('fixture')]),
    );
    writeExecutable('curl', '#!/bin/sh\nprintf \'{"ok":true}\'\n');
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeExecutable(name: string, contents: string): void {
    const path = join(binDir, name);
    writeFileSync(path, contents);
    chmodSync(path, 0o755);
  }

  function runUpload(args: string[], extraEnv: Record<string, string> = {}) {
    return spawnSync('bash', [UPLOAD_SCRIPT, ...args], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        TILES_DIR: tilesDir,
        CONTOUR_WORKER_URL: 'https://contours.test.example',
        COMMAND_LOG: commandLog,
        ...extraEnv,
      },
    });
  }

  it('keeps the build filename and Worker R2 key aligned', () => {
    const buildSource = readFileSync(
      resolve(PROJECT_ROOT, 'scripts/build-contours-australia.ts'),
      'utf8',
    );
    const workerSource = readFileSync(
      resolve(PROJECT_ROOT, 'workers/contour-tiles/src/index.ts'),
      'utf8',
    );

    expect(buildSource).toContain("const OUTPUT_FILENAME = 'australia-contours.pmtiles'");
    expect(workerSource).toContain("contours: 'contours/australia.pmtiles'");
  });

  it('uploads a small archive to the exact Worker key via Wrangler', () => {
    writeExecutable(
      'wrangler',
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$COMMAND_LOG"\n',
    );

    const result = runUpload(['--contours'], { WRANGLER_MAX_BYTES: '999999' });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(readFileSync(commandLog, 'utf8')).toContain(
      'r2 object put aus-map-data/contours/australia.pmtiles',
    );
    expect(result.stdout).toContain('Verified:');
  });

  it('uploads a large archive to the exact Worker key via the selected rclone remote', () => {
    writeExecutable(
      'rclone',
      [
        '#!/bin/sh',
        'if [ "$1" = "listremotes" ]; then',
        '  printf \'owner-r2:\\n\'',
        'elif [ "$1" = "copyto" ]; then',
        '  printf \'%s\\n\' "$*" >> "$COMMAND_LOG"',
        'fi',
        '',
      ].join('\n'),
    );

    const result = runUpload(['--contours'], {
      RCLONE_REMOTE: 'owner-r2',
      WRANGLER_MAX_BYTES: '1',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const command = readFileSync(commandLog, 'utf8');
    expect(command).toContain('--s3-no-check-bucket');
    expect(command).toContain('--s3-upload-cutoff 64M --s3-chunk-size 64M');
    expect(command).toContain('owner-r2:aus-map-data/contours/australia.pmtiles');
  });

  it('fails instead of reporting success when the Worker cannot see the uploaded archive', () => {
    writeExecutable(
      'curl',
      '#!/bin/sh\nprintf \'{"ok":false,"error":"Contour archive not found"}\'\nexit 22\n',
    );

    const result = runUpload(['--verify-contours']);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('Contour archive not found');
    expect(result.stdout).toContain('same Cloudflare account');
    expect(result.stdout).not.toContain('Upload complete');
  });
});
