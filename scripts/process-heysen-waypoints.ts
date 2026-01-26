/**
 * Process Heysen Trail waypoints from Caltopo GeoJSON export.
 *
 * This script:
 * 1. Cleans up HTML tags from description fields
 * 2. Categorizes waypoints into folders based on their description
 * 3. Outputs an updated GeoJSON file
 *
 * Usage: tsx scripts/process-heysen-waypoints.ts <input.json> [output.json]
 *   - input.json: Caltopo GeoJSON export file
 *   - output.json: Output file (defaults to input with -processed suffix)
 */

import * as fs from 'fs';

// Types for Caltopo GeoJSON
interface CaltopoFeature {
  geometry: {
    coordinates: [number, number, number, number];
    type: 'Point';
  } | null;
  id: string;
  type: 'Feature';
  properties: {
    title: string;
    class: 'Marker' | 'Folder' | 'Shape' | 'Track';
    description?: string;
    folderId?: string;
    [key: string]: unknown;
  };
}

interface CaltopoGeoJSON {
  features: CaltopoFeature[];
  type: 'FeatureCollection';
}

// Folder definitions with their matching patterns
interface FolderDef {
  id: string;
  title: string;
  patterns: RegExp[];
}

const FOLDER_DEFS: FolderDef[] = [
  {
    id: 'folder-campsites',
    title: 'Campsites',
    patterns: [
      /^campsite$/i,
      /^['']walk-in[''] site$/i,
      /^walk-in site$/i,
      /^shelter\s*\(small\)$/i,
    ],
  },
  {
    id: 'folder-huts-shelters',
    title: 'Huts & Shelters',
    patterns: [
      /^hut$/i,
      /^shelter\s*\(medium\)$/i,
      /^shelter\s*\(large\)$/i,
    ],
  },
  {
    id: 'folder-accommodation',
    title: 'Accommodation',
    patterns: [
      /^hotel\/pub$/i,
      /^motel$/i,
      /^b&amp;b$/i,
      /^b&b$/i,
      /^self contained unit\/house$/i,
      /^backpackers$/i,
      /^shearer['']?s quarters$/i,
    ],
  },
  {
    id: 'folder-caravan-parks',
    title: 'Caravan Parks',
    patterns: [
      /^caravan park$/i,
    ],
  },
  {
    id: 'folder-towns',
    title: 'Towns',
    patterns: [
      /^town$/i,
    ],
  },
  {
    id: 'folder-water',
    title: 'Water',
    patterns: [
      /^water only location$/i,
      /^water tank$/i,
    ],
  },
  {
    id: 'folder-trailheads',
    title: 'Trailheads',
    patterns: [
      /^trailhead$/i,
    ],
  },
  {
    id: 'folder-closed',
    title: 'Closed',
    patterns: [
      /no longer available/i,
      /^this facility is no longer available/i,
    ],
  },
  {
    id: 'folder-other',
    title: 'Other',
    patterns: [
      /^other$/i,
    ],
  },
];

/**
 * Clean HTML from a description string.
 * - Removes <br>, <br/>, <br /> tags (replace with newlines)
 * - Extracts href from anchor tags and formats as "text (url)"
 * - Removes img tags entirely
 * - Decodes HTML entities
 * - Trims whitespace
 */
function cleanDescription(desc: string): { cleaned: string; categories: string[]; url?: string } {
  if (!desc) {
    return { cleaned: '', categories: [] };
  }

  let text = desc;

  // Extract the URL from anchor tag before removing it
  let url: string | undefined;
  const urlMatch = text.match(/<a\s+href=["']([^"']+)["'][^>]*>.*?<\/a>/i);
  if (urlMatch) {
    url = urlMatch[1];
  }

  // Extract all categories (meaningful text lines before any URL/HTML-only content)
  const lines = text.split(/\n|<br\s*\/?>/gi);
  const categories: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines and lines that are just HTML tags
    if (trimmed && !trimmed.startsWith('<')) {
      // Clean HTML entities for comparison
      const cleaned = trimmed
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\t+/g, ' ')
        .trim();
      if (cleaned) {
        categories.push(cleaned);
      }
    }
  }

  // Replace <br> tags with newlines
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // Remove anchor tags but keep the text content
  text = text.replace(/<a\s+[^>]*>([^<]*)<\/a>/gi, '$1');

  // Remove img tags entirely
  text = text.replace(/<img\s+[^>]*>/gi, '');

  // Remove any remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  // Clean up whitespace
  text = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && line !== 'More details')
    .join('\n')
    .trim();

  // Add URL at the end if present
  if (url) {
    text = text ? `${text}\n\nMore info: ${url}` : url;
  }

  return { cleaned: text, categories, url };
}

/**
 * Find the appropriate folder for a single category string.
 */
function findFolder(category: string): FolderDef | undefined {
  for (const folder of FOLDER_DEFS) {
    for (const pattern of folder.patterns) {
      if (pattern.test(category)) {
        return folder;
      }
    }
  }
  return undefined;
}

// Priority order for folder selection when multiple categories match.
// Lower index = higher priority.
const FOLDER_PRIORITY: string[] = [
  'folder-closed',
  'folder-accommodation',
  'folder-caravan-parks',
  'folder-huts-shelters',
  'folder-campsites',
  'folder-trailheads',
  'folder-towns',
  'folder-water',
  'folder-other',
];

/**
 * Choose the best folder from multiple categories.
 *
 * Priority rules:
 * 1. If the waypoint name contains "caravan park", prefer Caravan Parks
 * 2. Closed facilities always win
 * 3. Accommodation beats Caravan Parks beats camping/shelters etc.
 */
function chooseBestFolder(categories: string[], title: string): FolderDef | undefined {
  const matches: FolderDef[] = [];
  for (const cat of categories) {
    const folder = findFolder(cat);
    if (folder) {
      matches.push(folder);
    }
  }

  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];

  // Special case: if the waypoint name contains "caravan park", prefer that folder
  if (/caravan park/i.test(title)) {
    const caravanMatch = matches.find(f => f.id === 'folder-caravan-parks');
    if (caravanMatch) return caravanMatch;
  }

  // Otherwise, pick the highest-priority folder
  return matches.sort((a, b) => {
    return FOLDER_PRIORITY.indexOf(a.id) - FOLDER_PRIORITY.indexOf(b.id);
  })[0];
}

/**
 * Try to detect category from marker title when description is empty.
 */
function detectCategoryFromTitle(title: string): FolderDef | undefined {
  const lowerTitle = title.toLowerCase();

  if (lowerTitle.includes('trailhead')) {
    return FOLDER_DEFS.find(f => f.id === 'folder-trailheads');
  }
  if (lowerTitle.includes('campsite') || lowerTitle.includes('camping')) {
    return FOLDER_DEFS.find(f => f.id === 'folder-campsites');
  }
  if (lowerTitle.includes('hut')) {
    return FOLDER_DEFS.find(f => f.id === 'folder-huts-shelters');
  }
  if (lowerTitle.includes('shelter')) {
    return FOLDER_DEFS.find(f => f.id === 'folder-huts-shelters');
  }
  if (lowerTitle.includes('water') || lowerTitle.includes('tank')) {
    return FOLDER_DEFS.find(f => f.id === 'folder-water');
  }
  if (lowerTitle.includes('hotel') || lowerTitle.includes('pub') || lowerTitle.includes('motel')) {
    return FOLDER_DEFS.find(f => f.id === 'folder-accommodation');
  }

  return undefined;
}

/**
 * Generate a UUID v4.
 */
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log('Usage: tsx scripts/process-heysen-waypoints.ts <input.json> [output.json]');
    console.log('');
    console.log('Options:');
    console.log('  --dry-run    Show what would be done without writing output');
    console.log('  --stats      Show statistics only');
    process.exit(1);
  }

  const dryRun = args.includes('--dry-run');
  const statsOnly = args.includes('--stats');
  const fileArgs = args.filter(a => !a.startsWith('--'));

  const inputPath = fileArgs[0];
  const outputPath = fileArgs[1] || inputPath.replace(/\.json$/, '-processed.json');

  if (!fs.existsSync(inputPath)) {
    console.error(`Error: Input file not found: ${inputPath}`);
    process.exit(1);
  }

  console.log('Heysen Trail Waypoint Processor');
  console.log('================================');
  console.log(`Input:  ${inputPath}`);
  if (!statsOnly) {
    console.log(`Output: ${outputPath}${dryRun ? ' (dry run)' : ''}`);
  }
  console.log('');

  // Load the GeoJSON
  const data: CaltopoGeoJSON = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));

  // Separate features by type
  const existingFolders = data.features.filter(f => f.properties.class === 'Folder');
  const markers = data.features.filter(f => f.properties.class === 'Marker');
  const otherFeatures = data.features.filter(f =>
    f.properties.class !== 'Folder' && f.properties.class !== 'Marker'
  );

  console.log(`Found ${markers.length} markers, ${existingFolders.length} existing folders, ${otherFeatures.length} other features`);
  console.log('');

  // Create a map of existing folder IDs by title (use first match for duplicates)
  const existingFoldersByTitle = new Map<string, string>();
  for (const f of existingFolders) {
    if (!existingFoldersByTitle.has(f.properties.title)) {
      existingFoldersByTitle.set(f.properties.title, f.id);
    }
  }

  // Create/update folders - use existing IDs if they match, otherwise create new
  const folderFeatures: CaltopoFeature[] = [];
  const folderIdMap = new Map<string, string>(); // our id -> actual UUID

  for (const def of FOLDER_DEFS) {
    const existingId = existingFoldersByTitle.get(def.title);
    const actualId = existingId || generateUUID();
    folderIdMap.set(def.id, actualId);

    // Find existing folder feature or create new
    const existingFolder = existingFolders.find(f => f.properties.title === def.title);

    if (existingFolder) {
      folderFeatures.push(existingFolder);
    } else {
      const now = Date.now();
      folderFeatures.push({
        geometry: null,
        id: actualId,
        type: 'Feature',
        properties: {
          title: def.title,
          class: 'Folder',
          visible: true,
          labelVisible: true,
          updated: now,
          '-created-on': now,
          '-updated-on': now,
        },
      });
    }
  }

  // Process markers
  const stats = {
    cleaned: 0,
    categorized: 0,
    uncategorized: 0,
    alreadyAssigned: 0,
    closedFacilities: 0,
  };

  const categoryBreakdown: Record<string, { count: number; folder: string | null; examples: string[] }> = {};

  const processedMarkers = markers.map(marker => {
    const { cleaned, categories } = cleanDescription(marker.properties.description || '');
    const categoryKey = categories.length > 0 ? categories.join(', ') : '(empty)';

    // Track category stats
    if (!categoryBreakdown[categoryKey]) {
      categoryBreakdown[categoryKey] = { count: 0, folder: null, examples: [] };
    }
    categoryBreakdown[categoryKey].count++;
    if (categoryBreakdown[categoryKey].examples.length < 3) {
      categoryBreakdown[categoryKey].examples.push(marker.properties.title);
    }

    // Check for "no longer available" in description
    const isClosedFacility = /no longer available/i.test(marker.properties.description || '');
    if (isClosedFacility) {
      stats.closedFacilities++;
    }

    // Find folder - choose best match from all categories
    let folder = chooseBestFolder(categories, marker.properties.title);

    // If no category found, try to detect from title
    if (!folder && categories.length === 0) {
      folder = detectCategoryFromTitle(marker.properties.title);
    }

    // If not found by category but marked as closed, use Closed folder
    if (!folder && isClosedFacility) {
      folder = FOLDER_DEFS.find(f => f.id === 'folder-closed');
    }

    if (folder) {
      categoryBreakdown[categoryKey].folder = folder.title;
    }

    // Determine if we should update the folder assignment
    const newFolderId = folder ? folderIdMap.get(folder.id) : undefined;
    const currentFolderId = marker.properties.folderId;

    if (cleaned !== marker.properties.description) {
      stats.cleaned++;
    }

    if (newFolderId && newFolderId !== currentFolderId) {
      stats.categorized++;
    } else if (currentFolderId) {
      stats.alreadyAssigned++;
    } else if (!newFolderId) {
      stats.uncategorized++;
    }

    return {
      ...marker,
      properties: {
        ...marker.properties,
        description: cleaned,
        ...(newFolderId ? { folderId: newFolderId } : {}),
      },
    };
  });

  // Print statistics
  console.log('=== Processing Statistics ===');
  console.log(`  Descriptions cleaned: ${stats.cleaned}`);
  console.log(`  Newly categorized: ${stats.categorized}`);
  console.log(`  Already assigned: ${stats.alreadyAssigned}`);
  console.log(`  Could not categorize: ${stats.uncategorized}`);
  console.log(`  Closed facilities found: ${stats.closedFacilities}`);
  console.log('');

  console.log('=== Category Breakdown ===');
  const sortedCategories = Object.entries(categoryBreakdown)
    .sort((a, b) => b[1].count - a[1].count);

  for (const [cat, info] of sortedCategories) {
    const folderStr = info.folder ? ` -> ${info.folder}` : ' -> (unassigned)';
    console.log(`  ${info.count.toString().padStart(3)} ${cat}${folderStr}`);
    if (!info.folder && info.examples.length > 0) {
      console.log(`        Examples: ${info.examples.join(', ')}`);
    }
  }
  console.log('');

  console.log('=== Folder Summary ===');
  const folderCounts = new Map<string, number>();
  for (const marker of processedMarkers) {
    if (marker.properties.folderId) {
      const folder = folderFeatures.find(f => f.id === marker.properties.folderId);
      const name = folder?.properties.title || 'Unknown';
      folderCounts.set(name, (folderCounts.get(name) || 0) + 1);
    }
  }
  for (const def of FOLDER_DEFS) {
    const count = folderCounts.get(def.title) || 0;
    console.log(`  ${count.toString().padStart(3)} ${def.title}`);
  }
  const unassigned = processedMarkers.filter(m => !m.properties.folderId).length;
  console.log(`  ${unassigned.toString().padStart(3)} (Unassigned)`);
  console.log('');

  if (statsOnly) {
    return;
  }

  // Build output
  const output: CaltopoGeoJSON = {
    type: 'FeatureCollection',
    features: [...folderFeatures, ...processedMarkers, ...otherFeatures],
  };

  if (dryRun) {
    console.log('Dry run complete. No files written.');
  } else {
    fs.writeFileSync(outputPath, JSON.stringify(output));
    console.log(`Written to: ${outputPath}`);
  }
}

main();
