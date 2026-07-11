import React from 'react';
import { Text, TextProps } from 'react-native';
import { MAX_FONT_SCALE } from '../tokens/typography';

/**
 * Drop-in Text with the app-wide font-scale clamp (decision: clamp, don't
 * disable). OS accessibility text sizes grow content up to 1.4× and then
 * stop, so large-text users get bigger type without rows clipping.
 *
 * Use this (directly or via the shared primitives) for any text whose
 * container has a fixed or min height.
 */
export function AppText(props: TextProps) {
  return <Text maxFontSizeMultiplier={MAX_FONT_SCALE} {...props} />;
}
