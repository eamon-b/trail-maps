/**
 * Custom trail import service.
 *
 * Orchestrates GPX file picking, processing, and storage for user-imported trails.
 */

import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { TrailDataService } from './trail-data-service';
import type { TrailJson } from './trail-loader';
import { processGpxAsync, type ProcessingOptions, type ProcessingResult, type ProcessingWarning, GpxParseError } from '../lib/gpx-processor';
import type { Trail as DisplayTrail } from '../lib/trail-utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImportResult {
  trailId: string;
  trailName: string;
  warnings: ProcessingWarning[];
}

export interface ImportError {
  type: 'file_picker' | 'validation' | 'network' | 'processing';
  message: string;
  suggestion?: string;
}

// ---------------------------------------------------------------------------
// File validation
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB
const GPX_EXTENSION = '.gpx';

function validateGpxFile(name: string, size: number | undefined): ImportError | null {
  const ext = name.toLowerCase().slice(name.lastIndexOf('.'));
  if (ext !== GPX_EXTENSION) {
    return {
      type: 'validation',
      message: `Expected a .gpx file, got "${ext}"`,
      suggestion: 'Make sure you are selecting a GPX file exported from your hiking app.',
    };
  }

  if (size !== undefined && size > MAX_FILE_SIZE_BYTES) {
    const sizeMB = (size / (1024 * 1024)).toFixed(1);
    return {
      type: 'validation',
      message: `File is too large (${sizeMB} MB). Maximum is 50 MB.`,
      suggestion: 'Try splitting your GPX file into smaller sections.',
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// File picking
// ---------------------------------------------------------------------------

export async function pickGpxFile(): Promise<{ uri: string; name: string; size?: number } | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['application/gpx+xml', 'application/xml', 'text/xml', '*/*'],
    copyToCacheDirectory: true,
  });

  if (result.canceled || result.assets.length === 0) {
    return null;
  }

  const asset = result.assets[0];
  return { uri: asset.uri, name: asset.name, size: asset.size ?? undefined };
}

// ---------------------------------------------------------------------------
// URL import
// ---------------------------------------------------------------------------

export async function fetchGpxFromUrl(url: string): Promise<{ content: string; name: string }> {
  // Basic URL validation
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw { type: 'network', message: 'Invalid URL', suggestion: 'Check that the URL is correct and starts with https://' } as ImportError;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw { type: 'network', message: 'URL must use http or https', suggestion: 'Check the URL format.' } as ImportError;
  }

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw { type: 'network', message: `Server returned ${response.status}`, suggestion: 'Check that the URL is correct and the file is publicly accessible.' } as ImportError;
    }

    const content = await response.text();

    // Derive filename from URL
    const pathSegments = parsed.pathname.split('/');
    const lastSegment = pathSegments[pathSegments.length - 1] || 'import.gpx';
    const name = lastSegment.endsWith('.gpx') ? lastSegment : `${lastSegment}.gpx`;

    return { content, name };
  } catch (e) {
    if ((e as ImportError).type === 'network') throw e;
    throw { type: 'network', message: 'Failed to download file', suggestion: 'Check your internet connection and try again.' } as ImportError;
  }
}

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

export async function processGpxFile(
  uri: string,
  name: string,
  size: number | undefined,
  options?: ProcessingOptions,
): Promise<ProcessingResult> {
  // Validate file
  const validationError = validateGpxFile(name, size);
  if (validationError) {
    throw validationError;
  }

  // Read file contents
  let content: string;
  try {
    content = await FileSystem.readAsStringAsync(uri);
  } catch {
    throw {
      type: 'file_picker',
      message: 'Could not read the file',
      suggestion: 'Try selecting the file again. The file may have been moved or deleted.',
    } as ImportError;
  }

  // Process (parseGpx validates XML/GPX format internally)
  try {
    return await processGpxAsync(content, {
      ...options,
      trailName: options?.trailName || nameFromFilename(name),
    });
  } catch (e) {
    if (e instanceof GpxParseError) {
      throw {
        type: 'processing',
        message: e.message,
        suggestion: gpxErrorSuggestion(e.message),
      } as ImportError;
    }
    throw {
      type: 'processing',
      message: 'Failed to process GPX file',
      suggestion: 'The file may be corrupted or in an unsupported format.',
    } as ImportError;
  }
}

export async function processGpxContent(
  content: string,
  name: string,
  options?: ProcessingOptions,
): Promise<ProcessingResult> {
  try {
    return await processGpxAsync(content, {
      ...options,
      trailName: options?.trailName || nameFromFilename(name),
    });
  } catch (e) {
    if (e instanceof GpxParseError) {
      throw {
        type: 'processing',
        message: e.message,
        suggestion: gpxErrorSuggestion(e.message),
      } as ImportError;
    }
    throw {
      type: 'processing',
      message: 'Failed to process GPX file',
      suggestion: 'The file may be corrupted or in an unsupported format.',
    } as ImportError;
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Generate a unique trail ID with timestamp to avoid collisions */
function generateCustomTrailId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const ts = Date.now().toString(36);
  return `custom-${slug}-${ts}`;
}

/** Save a processed trail to SQLite */
export async function saveCustomTrail(
  result: ProcessingResult,
  trailName: string,
  sourceFilename: string,
): Promise<ImportResult> {
  const service = await TrailDataService.create();
  const trailId = generateCustomTrailId(trailName);
  const trail = result.trail;

  // Build the TrailJson structure for storage
  const trackData: TrailJson = {
    config: {
      ...trail.config,
      id: trailId,
      name: trailName,
    },
    waypoints: trail.waypoints.map((wp) => ({
      name: wp.name,
      lat: wp.lat,
      lon: wp.lon,
      type: wp.type,
      description: wp.description,
      elevation: wp.elevation,
      distance: wp.distance,
      totalDistance: wp.totalDistance,
    })),
    track: {
      points: trail.track.points,
      displayPoints: trail.track.displayPoints || trail.track.points,
      totalDistance: trail.track.totalDistance,
      totalAscent: trail.track.totalAscent,
      totalDescent: trail.track.totalDescent,
    },
  };

  // Store trail metadata
  const shortName = trailName.length > 10 ? trailName.substring(0, 10).toUpperCase() : trailName.toUpperCase();

  await service.storeTrail({
    id: trailId,
    name: trailName,
    shortName,
    region: 'Custom',
    lengthKm: Math.round(trail.track.totalDistance * 10) / 10,
    metadataJson: JSON.stringify({
      direction: trail.config.direction,
      track: {
        totalDistance: trail.track.totalDistance,
        totalAscent: trail.track.totalAscent,
        totalDescent: trail.track.totalDescent,
        displayPointCount: (trail.track.displayPoints || trail.track.points).length,
      },
      warnings: result.warnings,
    }),
    dataVersion: null,
    isCustom: true,
    sourceFilename,
  });

  // Store the full track data
  await service.storeCustomTrailData(trailId, trackData);

  // Store waypoints in the waypoints table for listing
  await service.storeWaypoints(
    trailId,
    trail.waypoints.map((wp) => ({
      name: wp.name,
      type: wp.type,
      lat: wp.lat,
      lon: wp.lon,
      ele: wp.elevation ?? null,
      kmPosition: wp.totalDistance ?? null,
      description: wp.description ?? null,
    })),
  );

  return {
    trailId,
    trailName,
    warnings: result.warnings,
  };
}

/** Delete a custom trail and all associated data */
export async function deleteCustomTrail(trailId: string): Promise<void> {
  const service = await TrailDataService.create();
  await service.deleteTrail(trailId);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nameFromFilename(filename: string): string {
  return filename
    .replace(/\.gpx$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function gpxErrorSuggestion(message: string): string {
  if (message.includes('no track data')) {
    return 'This file has no track data. Make sure you are exporting tracks, not just waypoints.';
  }
  if (message.includes('fewer than 2')) {
    return 'The file has too few valid points. It may be corrupted or incomplete.';
  }
  if (message.includes('not valid XML') || message.includes('not a GPX')) {
    return 'This does not appear to be a GPX file. Check that you are selecting the right file.';
  }
  return 'Try re-exporting the file from your hiking app.';
}
