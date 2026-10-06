/**
 * Tests for GPX coordinate parsing safety.
 *
 * build-tiles.ts now uses parseCoordinate() which throws on missing/NaN values
 * instead of silently defaulting to 0. These tests verify the safe behavior.
 */

import { describe, it, expect } from 'vitest';
import { parseCoordinate } from './parse-coordinate';

describe('GPX coordinate parsing safety', () => {
  it('throws on null attribute', () => {
    expect(() => parseCoordinate(null, 'lat', 'trkpt')).toThrow('Missing lat');
  });

  it('throws on empty string', () => {
    expect(() => parseCoordinate('', 'lon', 'trkpt')).toThrow('Missing lon');
  });

  it('throws on non-numeric string', () => {
    expect(() => parseCoordinate('abc', 'lat', 'trkpt')).toThrow('Invalid lat');
  });

  it('parses valid negative coordinate', () => {
    expect(parseCoordinate('-35.28', 'lat', 'trkpt')).toBe(-35.28);
  });

  it('parses valid positive coordinate', () => {
    expect(parseCoordinate('148.5', 'lon', 'trkpt')).toBe(148.5);
  });

  it('parses zero as a valid coordinate', () => {
    expect(parseCoordinate('0', 'lat', 'trkpt')).toBe(0);
  });

  it('rejects a number with trailing junk instead of reading its prefix', () => {
    // parseFloat('-37.1abc') is -37.1.
    expect(() => parseCoordinate('-37.1abc', 'lat', 'trkpt')).toThrow('Invalid lat');
    expect(() => parseCoordinate('151.2.3', 'lon', 'trkpt')).toThrow('Invalid lon');
    expect(() => parseCoordinate('12 34', 'lon', 'trkpt')).toThrow('Invalid lon');
  });

  it('rejects Infinity, NaN and an exponent that overflows', () => {
    expect(() => parseCoordinate('Infinity', 'lat', 'trkpt')).toThrow('Invalid lat');
    expect(() => parseCoordinate('-Infinity', 'lon', 'trkpt')).toThrow('Invalid lon');
    expect(() => parseCoordinate('NaN', 'lat', 'trkpt')).toThrow('Invalid lat');
    expect(() => parseCoordinate('1e999', 'lat', 'trkpt')).toThrow('Invalid lat');
  });

  it('rejects coordinates off the globe', () => {
    expect(() => parseCoordinate('90.0001', 'lat', 'wpt')).toThrow(/Out-of-range lat/);
    expect(() => parseCoordinate('-91', 'lat', 'wpt')).toThrow(/Out-of-range lat/);
    expect(() => parseCoordinate('180.5', 'lon', 'wpt')).toThrow(/Out-of-range lon/);
  });

  it('accepts every plain decimal spelling, at the edges of the range too', () => {
    expect(parseCoordinate('+33.5', 'lat', 'trkpt')).toBe(33.5);
    expect(parseCoordinate('.5', 'lat', 'trkpt')).toBe(0.5);
    expect(parseCoordinate('-5.', 'lat', 'trkpt')).toBe(-5);
    expect(parseCoordinate('1.5e1', 'lon', 'trkpt')).toBe(15);
    expect(parseCoordinate(' -33.1 ', 'lat', 'trkpt')).toBe(-33.1);
    expect(parseCoordinate('-90', 'lat', 'trkpt')).toBe(-90);
    expect(parseCoordinate('180', 'lon', 'trkpt')).toBe(180);
  });
});
