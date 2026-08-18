/**
 * Direction labelling for the guide's direction toggle.
 *
 * FarOut names each direction of travel (e.g. "Northbound" / "Southbound").
 * Bundled trails carry those names in `config.direction`; when a trail lacks
 * them we fall back to generic "Forward" / "Reversed". Pure so the mapping is
 * unit-testable.
 */

import type { Direction } from '../../state/settings-store';

/** The `config.direction` shape carried by bundled trails (both optional). */
export interface DirectionNames {
  default?: string;
  reversed?: string;
}

/** The travel-direction name for the given direction, with a generic fallback. */
export function directionLabel(names: DirectionNames | undefined, direction: Direction): string {
  if (direction === 'reversed') return names?.reversed || 'Reversed';
  return names?.default || 'Forward';
}

/** The other direction (for a toggle's "switch to …" affordance). */
export function otherDirection(direction: Direction): Direction {
  return direction === 'default' ? 'reversed' : 'default';
}
