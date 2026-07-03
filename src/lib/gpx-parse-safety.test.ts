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
});
