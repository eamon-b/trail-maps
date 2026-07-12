/**
 * Photo attachments for custom waypoints (one per waypoint, local-only).
 *
 * Capture (camera or library) via expo-image-picker, downscale to
 * MAX_DIMENSION px / JPEG_QUALITY via expo-image-manipulator — waypoint
 * photos are for identification (which tank, which junction), not art, and
 * small files keep GPX-adjacent exports and any future community uploads
 * sane — then store under documentDirectory/waypoint-photos/.
 *
 * Nothing in this module uploads anything.
 */

import { Directory, File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';

export const MAX_DIMENSION = 1600;
export const JPEG_QUALITY = 0.8;
const PHOTO_DIR_NAME = 'waypoint-photos';

export type PhotoSource = 'camera' | 'library';

/**
 * Compute the resize target so the longest edge is at most `max` px while
 * preserving aspect ratio. Returns null when the image is already small
 * enough (no resize action needed).
 */
export function constrainDimensions(
  width: number,
  height: number,
  max: number = MAX_DIMENSION,
): { width: number; height: number } | null {
  if (width <= 0 || height <= 0) return null;
  if (width <= max && height <= max) return null;
  if (width >= height) {
    return { width: max, height: Math.round((height / width) * max) };
  }
  return { width: Math.round((width / height) * max), height: max };
}

function photoDir(): Directory {
  return new Directory(Paths.document, PHOTO_DIR_NAME);
}

/** Build the stable destination file for a waypoint's photo. */
function photoFile(waypointId: string): File {
  return new File(photoDir(), `${waypointId}.jpg`);
}

/**
 * Launch the camera or photo library and return the picked image's temporary
 * URI plus its dimensions, or null if the user cancelled (or the camera
 * permission was refused).
 */
export async function pickWaypointPhoto(
  source: PhotoSource,
): Promise<{ uri: string; width: number; height: number } | null> {
  let result: ImagePicker.ImagePickerResult;
  if (source === 'camera') {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return null;
    result = await ImagePicker.launchCameraAsync({ quality: 1 });
  } else {
    result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 1,
    });
  }
  if (result.canceled || !result.assets || result.assets.length === 0) return null;
  const asset = result.assets[0];
  return { uri: asset.uri, width: asset.width ?? 0, height: asset.height ?? 0 };
}

/**
 * Downscale a picked image (≤ MAX_DIMENSION px, ~80% JPEG) and store it as
 * the given waypoint's photo. Returns the stored file URI. Replaces any
 * existing photo for the waypoint.
 */
export async function storeWaypointPhoto(
  waypointId: string,
  picked: { uri: string; width: number; height: number },
): Promise<string> {
  // Some Android content providers report 0×0 dimensions. Without a known
  // size constrainDimensions can't decide, so cap width at MAX_DIMENSION and
  // let expo-image-manipulator preserve aspect (it scales height when only
  // width is given) — otherwise the full-resolution image slips through.
  const resize =
    picked.width > 0 && picked.height > 0
      ? constrainDimensions(picked.width, picked.height)
      : { width: MAX_DIMENSION };
  const manipulated = await manipulateAsync(
    picked.uri,
    resize ? [{ resize }] : [],
    { compress: JPEG_QUALITY, format: SaveFormat.JPEG },
  );

  const dir = photoDir();
  if (!dir.exists) dir.create({ intermediates: true });

  const dest = photoFile(waypointId);
  if (dest.exists) dest.delete();
  new File(manipulated.uri).copy(dest);
  return dest.uri;
}

/**
 * Delete a waypoint photo file by its stored URI. Idempotent — a missing
 * file (already cleaned up, migrated device) is not an error.
 */
export function deleteWaypointPhoto(photoUri: string | null | undefined): void {
  if (!photoUri) return;
  try {
    const file = new File(photoUri);
    if (file.exists) file.delete();
  } catch {
    // Best effort — an orphaned file is preferable to a crash.
  }
}
