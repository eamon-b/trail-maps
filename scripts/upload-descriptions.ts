/**
 * Push curated waypoint descriptions to the comments API.
 *
 * The authored source of truth is `data/trails/<trail>/descriptions.json` — the
 * same file the trail build bundles into the app. This script pushes it to the
 * `waypoint_descriptions` table in D1 so installed apps pick the text up over
 * the sync channel (`GET /v1/trails/:trailId/descriptions?since=`) without
 * waiting for a new build. Bundled and synced text share the waypoint-id key
 * space, and the app renders `synced ?? bundled`.
 *
 * Usage:
 *   # See exactly what would be sent (no token needed, no network):
 *   npm run upload:descriptions -- --dry-run
 *
 *   # Push one trail:
 *   TRACKNOTES_ADMIN_TOKEN=... npm run upload:descriptions -- \
 *     --trail cape_to_cape --api https://<comments-api-host>
 *
 * Options:
 *   --trail <id>    Only this trail (default: every trail with a descriptions.json)
 *   --api <url>     API base URL (default: $TRACKNOTES_API_BASE_URL)
 *   --dry-run       Print the requests instead of sending them
 *
 * Auth: an admin bearer token, read from $TRACKNOTES_ADMIN_TOKEN. Pass it on
 * the command line for a single run; this script never reads dotfiles or any
 * other credential store.
 *
 * The endpoint upserts, so re-running is safe and idempotent — a row is only
 * rewritten when its text changed. Descriptions are never deleted here: to
 * withdraw one, PUT an empty string (the API stores that as a tombstone) and
 * delete the entry from descriptions.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  DESCRIPTIONS_FILENAME,
  loadCuratedDescriptions,
  type CuratedDescription,
} from './lib/waypoint-descriptions.js';
import type { UpsertDescriptionRequest } from '../src/lib/comments-api-types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TRAILS_DIR = path.join(__dirname, '..', 'data', 'trails');

const ADMIN_TOKEN_ENV = 'TRACKNOTES_ADMIN_TOKEN';
const API_BASE_ENV = 'TRACKNOTES_API_BASE_URL';

interface Options {
  trailId?: string;
  apiBase?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--trail') {
      options.trailId = argv[++i];
    } else if (arg === '--api') {
      options.apiBase = argv[++i];
    } else {
      throw new Error(`Unknown argument "${arg}". See the header of ${path.basename(__filename)}.`);
    }
  }
  if (options.trailId === undefined && argv.includes('--trail')) {
    throw new Error('--trail needs a trail id');
  }
  if (options.apiBase === undefined && argv.includes('--api')) {
    throw new Error('--api needs a base URL');
  }
  return options;
}

/**
 * A trail's directory name is not its id: `AAWT` builds `aawt` and
 * `Hume_and_Hovell` builds `hume-and-hovell`. The API path, the registry and
 * the `trailId` inside descriptions.json all use the id, so carry both.
 */
interface AuthoredTrail {
  /** Directory under data/trails/ holding the descriptions file. */
  dir: string;
  /** The trail's build id, from its trail.json. */
  trailId: string;
}

/** Every trail directory that has authored descriptions, in stable order. */
function findTrailsWithDescriptions(only?: string): AuthoredTrail[] {
  const entries = fs
    .readdirSync(TRAILS_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(name => fs.existsSync(path.join(TRAILS_DIR, name, DESCRIPTIONS_FILENAME)))
    .map(dir => {
      const configPath = path.join(TRAILS_DIR, dir, 'trail.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { id?: string };
      if (typeof config.id !== 'string' || config.id.length === 0) {
        throw new Error(`${configPath}: missing "id"`);
      }
      return { dir, trailId: config.id };
    })
    .sort((a, b) => a.trailId.localeCompare(b.trailId));

  if (!only) return entries;
  // Accept either the id (what the API wants) or the directory name (what a
  // shell tab-completes), since the two differ for some trails.
  const match = entries.find(entry => entry.trailId === only || entry.dir === only);
  if (!match) {
    throw new Error(
      `Trail "${only}" has no ${DESCRIPTIONS_FILENAME}. Trails with curated descriptions: ${entries.map(entry => entry.trailId).join(', ') || '(none)'}`
    );
  }
  return [match];
}

async function putDescription(
  apiBase: string,
  token: string,
  trailId: string,
  entry: CuratedDescription
): Promise<void> {
  const url = `${apiBase.replace(/\/+$/, '')}/v1/admin/trails/${encodeURIComponent(trailId)}/descriptions/${encodeURIComponent(entry.waypointId)}`;
  const body: UpsertDescriptionRequest = { description: entry.description };

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `PUT ${entry.waypointId} failed: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`
    );
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const trails = findTrailsWithDescriptions(options.trailId);

  if (trails.length === 0) {
    console.log(`No trail has a ${DESCRIPTIONS_FILENAME} yet — nothing to upload.`);
    return;
  }

  const apiBase = options.apiBase ?? process.env[API_BASE_ENV];
  const token = process.env[ADMIN_TOKEN_ENV];

  if (!options.dryRun) {
    if (!apiBase) throw new Error(`No API base URL. Pass --api <url> or set $${API_BASE_ENV}.`);
    if (!token) {
      throw new Error(
        `No admin token. Set $${ADMIN_TOKEN_ENV} for this command (e.g. ${ADMIN_TOKEN_ENV}=... npm run upload:descriptions -- ...), or re-run with --dry-run.`
      );
    }
  }

  let total = 0;
  for (const { dir, trailId } of trails) {
    const entries = loadCuratedDescriptions(path.join(TRAILS_DIR, dir), trailId);
    console.log(`\n${trailId}: ${entries.length} description(s)`);

    for (const entry of entries) {
      const label = `  ${entry.waypointId}${entry.name ? ` (${entry.name})` : ''}`;
      if (options.dryRun) {
        const target = apiBase ?? `<${API_BASE_ENV}>`;
        console.log(`${label}\n    PUT ${target}/v1/admin/trails/${trailId}/descriptions/${entry.waypointId}`);
        console.log(`    ${JSON.stringify({ description: entry.description } satisfies UpsertDescriptionRequest)}`);
      } else {
        await putDescription(apiBase!, token!, trailId, entry);
        console.log(`${label} ✓`);
      }
      total++;
    }
  }

  console.log(
    options.dryRun
      ? `\nDry run: ${total} description(s) would be uploaded across ${trails.length} trail(s).`
      : `\nUploaded ${total} description(s) across ${trails.length} trail(s).`
  );
}

main().catch(error => {
  console.error(`\nupload-descriptions failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
