/** Parse a coordinate attribute, throwing on missing or invalid values instead of defaulting to 0. */
export function parseCoordinate(attr: string | null, name: string, context: string): number {
  if (attr == null || attr === '') {
    throw new Error(`Missing ${name} attribute on ${context}`);
  }
  const val = parseFloat(attr);
  if (Number.isNaN(val)) {
    throw new Error(`Invalid ${name} value "${attr}" on ${context}`);
  }
  return val;
}
