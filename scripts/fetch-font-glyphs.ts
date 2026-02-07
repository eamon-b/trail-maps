/**
 * Fetch PBF Font Glyphs for Offline MapLibre Text Rendering
 *
 * Downloads Open Sans Regular PBF glyph ranges from the openmaptiles fonts CDN.
 * These are required for offline contour labels and place names.
 *
 * Output: mobile/assets/fonts/Open Sans Regular/{range}.pbf
 *
 * Usage: npx tsx scripts/fetch-font-glyphs.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

const SCRIPTS_DIR = path.dirname(
  process.platform === 'win32'
    ? new URL(import.meta.url).pathname.slice(1).replace(/\//g, '\\')
    : new URL(import.meta.url).pathname
);
const PROJECT_ROOT = path.resolve(SCRIPTS_DIR, '..');
const FONTS_OUTPUT_DIR = path.join(PROJECT_ROOT, 'mobile/assets/fonts');

// OpenMapTiles font CDN base URL
const FONT_CDN_BASE = 'https://fonts.openmaptiles.org';

// Font stacks to download — must match what the topo style.json references
const FONT_STACKS = ['Open Sans Regular'];

// PBF glyph ranges (each file covers 256 codepoints)
// We only need ranges that cover Latin, Latin Extended, and common symbols.
// Full Unicode coverage would be 0-65535 (256 files), but we only need ~20 for
// English text + European diacritics used in Australian place names.
const GLYPH_RANGES = [
  '0-255',       // Basic Latin + Latin-1 Supplement (A-Z, a-z, 0-9, àéîôü, etc.)
  '256-511',     // Latin Extended-A (ăĕğ etc.)
  '512-767',     // Latin Extended-B
  '768-1023',    // Combining diacritical marks + Greek
  '8192-8447',   // General punctuation (—, –, ', ", etc.)
  '8448-8703',   // Letterlike symbols
];

function fetchFile(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          fetchFile(redirectUrl).then(resolve).catch(reject);
          return;
        }
      }

      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        return;
      }

      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    }).on('error', reject);
  });
}

async function main(): Promise<void> {
  console.log('Font Glyph Downloader');
  console.log('=====================\n');

  let totalFiles = 0;
  let totalBytes = 0;

  for (const fontStack of FONT_STACKS) {
    const fontDir = path.join(FONTS_OUTPUT_DIR, fontStack);
    if (!fs.existsSync(fontDir)) {
      fs.mkdirSync(fontDir, { recursive: true });
    }

    console.log(`Downloading: ${fontStack}`);

    for (const range of GLYPH_RANGES) {
      const url = `${FONT_CDN_BASE}/${encodeURIComponent(fontStack)}/${range}.pbf`;
      const outputPath = path.join(fontDir, `${range}.pbf`);

      // Skip if already downloaded
      if (fs.existsSync(outputPath)) {
        const size = fs.statSync(outputPath).size;
        console.log(`  ✓ ${range}.pbf (${size} bytes, cached)`);
        totalFiles++;
        totalBytes += size;
        continue;
      }

      try {
        const data = await fetchFile(url);
        fs.writeFileSync(outputPath, data);
        console.log(`  ✓ ${range}.pbf (${data.length} bytes)`);
        totalFiles++;
        totalBytes += data.length;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`  ✗ ${range}.pbf: ${message}`);
      }
    }
  }

  console.log(`\nDone: ${totalFiles} files, ${(totalBytes / 1024).toFixed(1)} KB total`);
  console.log(`Output: ${FONTS_OUTPUT_DIR}`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
