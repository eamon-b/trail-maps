/**
 * Pure helpers for the comment photo-attach flow, kept free of React and native
 * modules so they unit-test in plain Node.
 *
 * The composer holds at most one selected photo (single-select picker). These
 * helpers turn a raw picker asset into the minimal `SelectedPhoto` the sync
 * layer needs, choose the wire content type from the asset's reported MIME, and
 * decide whether the composer has something worth posting.
 */

import type { PhotoContentType, WaterStatus } from '@lib/comments-api-types';

/** A photo chosen in the composer, ready to attach to a comment. */
export interface SelectedPhoto {
  /** Local URI (`file://` / `content://`) the upload reads bytes from. */
  uri: string;
  /** Wire content type the raw upload sends. */
  contentType: PhotoContentType;
}

/** The subset of an expo-image-picker asset these helpers rely on. */
export interface PickedAssetLike {
  uri?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
}

/** The subset of a picker result these helpers rely on. */
export interface PickerResultLike {
  canceled: boolean;
  assets?: PickedAssetLike[] | null;
}

/**
 * Map a reported MIME type to the API's accepted photo content types. The
 * backend only takes JPEG or WebP; the picker re-encodes at our chosen quality,
 * typically to JPEG, so anything that isn't explicitly WebP is treated as JPEG.
 */
export function pickPhotoContentType(mimeType?: string | null): PhotoContentType {
  const lower = mimeType?.toLowerCase() ?? '';
  if (lower === 'image/webp') return 'image/webp';
  return 'image/jpeg';
}

/**
 * Convert a single picker asset into a `SelectedPhoto`, or `null` when the asset
 * lacks a usable URI. Callers pass `assets[0]` (single-select).
 */
export function assetToSelectedPhoto(asset: PickedAssetLike | null | undefined): SelectedPhoto | null {
  const uri = asset?.uri;
  if (!uri) return null;
  return { uri, contentType: pickPhotoContentType(asset?.mimeType) };
}

/**
 * Pull the first selected photo out of a picker result, or `null` when the user
 * canceled or the result is empty.
 */
export function selectedPhotoFromResult(result: PickerResultLike | null | undefined): SelectedPhoto | null {
  if (!result || result.canceled) return null;
  return assetToSelectedPhoto(result.assets?.[0]);
}

/** Whether the composer has anything worth posting: text, a water report, or a photo. */
export function hasComposerContent(input: {
  text: string;
  waterStatus: WaterStatus | null;
  photo: SelectedPhoto | null;
}): boolean {
  return input.text.trim().length > 0 || input.waterStatus !== null || input.photo !== null;
}
