/**
 * GPX export via the OS share sheet (P1 PR B).
 *
 * Writes the serialized GPX to the cache directory and hands the file to
 * expo-sharing. Zero server work: user data leaves the phone through
 * whatever the OS share sheet offers (Files, AirDrop, mail, messaging).
 */

import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

const EXPORT_DIR_NAME = 'gpx-exports';
const GPX_MIME_TYPE = 'application/gpx+xml';

/** Sanitize a display name into a safe .gpx filename. */
export function gpxFilename(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${base || 'export'}.gpx`;
}

/**
 * Write `gpx` to the cache directory under `filename` and open the OS share
 * sheet for it. Throws when sharing is unavailable on the device.
 */
export async function shareGpxFile(filename: string, gpx: string): Promise<void> {
  const available = await Sharing.isAvailableAsync();
  if (!available) {
    throw new Error('Sharing is not available on this device');
  }

  const dir = new Directory(Paths.cache, EXPORT_DIR_NAME);
  if (!dir.exists) dir.create({ intermediates: true });

  const file = new File(dir, filename);
  if (file.exists) file.delete();
  file.write(gpx);

  await Sharing.shareAsync(file.uri, {
    mimeType: GPX_MIME_TYPE,
    dialogTitle: filename,
  });
}
