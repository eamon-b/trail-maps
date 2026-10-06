/**
 * A whole-string decimal number: optional sign, digits with an optional
 * fraction (or a bare fraction), optional exponent. `parseFloat` alone reads
 * the longest numeric prefix, so `-37.1abc` came back as -37.1 and `Infinity`
 * as Infinity, both plotted as if they were coordinates.
 */
const DECIMAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

const RANGES = { lat: 90, lon: 180 } as const;

/**
 * Parse a coordinate attribute, throwing on missing, malformed or out-of-range
 * (beyond ±90 lat, ±180 lon) values instead of defaulting to 0.
 */
export function parseCoordinate(attr: string | null, name: 'lat' | 'lon', context: string): number {
  if (attr == null || attr === '') {
    throw new Error(`Missing ${name} attribute on ${context}`);
  }
  // XML allows whitespace around an attribute's value in practice, and the DOM
  // hands it through untrimmed.
  const trimmed = attr.trim();
  const val = DECIMAL_PATTERN.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isFinite(val)) {
    throw new Error(`Invalid ${name} value "${attr}" on ${context}`);
  }
  const limit = RANGES[name];
  if (Math.abs(val) > limit) {
    throw new Error(`Out-of-range ${name} value "${attr}" on ${context} (must be within ±${limit})`);
  }
  return val;
}
