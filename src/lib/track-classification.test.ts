import { describe, it, expect } from 'vitest';
import {
  classifyTracks,
  combineTracksGeographically,
  TRACK_CLASSIFICATION_DEFAULTS,
} from './track-classification';
import type { GpxPoint, TrackClassificationConfig } from './types';

// Helper to create mock point arrays
function mockPoints(count: number, startLat = -34.0, startLon = 138.0): GpxPoint[] {
  return Array.from({ length: count }, (_, i) => ({
    lat: startLat + i * 0.01,
    lon: startLon + i * 0.01,
    ele: 100 + i,
    time: null,
  }));
}

describe('classifyTracks', () => {
  describe('main route identification', () => {
    it('should match Heysen map patterns (Map 1A, Map 2B, etc)', () => {
      const tracks = [
        { name: 'Map 1A', points: mockPoints(10) },
        { name: 'Map 1B', points: mockPoints(10) },
        { name: 'Map 8D', points: mockPoints(10) },
        { name: 'Spur to Town', points: mockPoints(5) },
      ];
      const config: TrackClassificationConfig = {
        mainRoutePatterns: ['^Map \\d+[A-D]$'],
      };

      const result = classifyTracks(tracks, config);

      expect(result.mainTracks).toHaveLength(3);
      expect(result.mainTracks.map(t => t.name)).toEqual(['Map 1A', 'Map 1B', 'Map 8D']);
    });

    it('should match AAWT section patterns (Section 1, etc)', () => {
      const tracks = [
        { name: 'Section 1', points: mockPoints(100) },
        { name: 'Section 2', points: mockPoints(100) },
        { name: 'ST: Side Trip Name', points: mockPoints(20) },
      ];
      const config: TrackClassificationConfig = {
        mainRoutePatterns: ['^Section \\d+$'],
      };

      const result = classifyTracks(tracks, config);

      expect(result.mainTracks).toHaveLength(2);
    });
  });

  describe('alternate route identification', () => {
    it('should identify tracks with "Alternative" in name (Heysen)', () => {
      const tracks = [
        { name: 'Map 1A', points: mockPoints(50) },
        { name: 'Alternative Route via Ridge', points: mockPoints(20) },
        { name: 'Alternatve Route (typo)', points: mockPoints(15) }, // actual typo in data
      ];
      const config: TrackClassificationConfig = {
        mainRoutePatterns: ['^Map \\d+[A-D]$'],
        alternatePatterns: ['Alternative', 'Alternatve', '\\bAlt\\b'],
      };

      const result = classifyTracks(tracks, config);

      expect(result.alternateTracks).toHaveLength(2);
    });

    it('should identify AAWT alternates with "Alt" prefix', () => {
      const tracks = [
        { name: 'Section 1', points: mockPoints(100) },
        { name: 'Alt 1: Bad Weather Route', points: mockPoints(30) },
        { name: 'Alt 2: Fire Detour', points: mockPoints(25) },
      ];
      const config: TrackClassificationConfig = {
        mainRoutePatterns: ['^Section \\d+$'],
        alternatePatterns: ['^Alt \\d+:'],
      };

      const result = classifyTracks(tracks, config);

      expect(result.alternateTracks).toHaveLength(2);
    });

    it('should use default alternate patterns when not configured', () => {
      const tracks = [
        { name: 'Main Trail', points: mockPoints(100) },
        { name: 'Detour around flood', points: mockPoints(20) },
        { name: 'Reroute 2024', points: mockPoints(15) },
      ];

      const result = classifyTracks(tracks, {});

      expect(result.alternateTracks.map(t => t.name)).toContain('Detour around flood');
      expect(result.alternateTracks.map(t => t.name)).toContain('Reroute 2024');
    });
  });

  describe('side trip identification', () => {
    it('should identify Heysen spurs', () => {
      const tracks = [
        { name: 'Map 1A', points: mockPoints(50) },
        { name: 'Spur to Mt Lofty', points: mockPoints(10) },
        { name: 'Water spur trail', points: mockPoints(5) },
      ];
      const config: TrackClassificationConfig = {
        mainRoutePatterns: ['^Map \\d+[A-D]$'],
        sideTripPatterns: ['Spur', 'spur trail'],
      };

      const result = classifyTracks(tracks, config);

      expect(result.sideTripTracks).toHaveLength(2);
    });

    it('should identify AAWT side trips with ST: prefix', () => {
      const tracks = [
        { name: 'Section 1', points: mockPoints(100) },
        { name: 'ST: Viewpoint', points: mockPoints(5) },
        { name: 'ST: Water Source', points: mockPoints(3) },
      ];
      const config: TrackClassificationConfig = {
        mainRoutePatterns: ['^Section \\d+$'],
        sideTripPatterns: ['^ST:'],
      };

      const result = classifyTracks(tracks, config);

      expect(result.sideTripTracks).toHaveLength(2);
    });

    it('should use default side trip patterns when not configured', () => {
      const tracks = [
        { name: 'Main Trail', points: mockPoints(100) },
        { name: 'Side Trip to Falls', points: mockPoints(10) },
      ];

      const result = classifyTracks(tracks, {});

      expect(result.sideTripTracks.map(t => t.name)).toContain('Side Trip to Falls');
    });
  });

  describe('ignore patterns', () => {
    it('should ignore tracks matching ignore patterns', () => {
      const tracks = [
        { name: 'Map 1A', points: mockPoints(50) },
        { name: 'Section 1', points: mockPoints(200) }, // Would be longest
        { name: 'OLD - Do not use', points: mockPoints(100) },
      ];
      const config: TrackClassificationConfig = {
        mainRoutePatterns: ['^Map \\d+[A-D]$'],
        ignorePatterns: ['^Section \\d+$', '^OLD'],
      };

      const result = classifyTracks(tracks, config);

      expect(result.mainTracks).toHaveLength(1);
      expect(result.ignoredTracks).toHaveLength(2);
    });
  });

  describe('fallback behavior', () => {
    it('should fall back to longest track when no main patterns match', () => {
      const tracks = [
        { name: 'Track A', points: mockPoints(10) },
        { name: 'Track B', points: mockPoints(100) }, // Longest
        { name: 'Track C', points: mockPoints(50) },
      ];

      const result = classifyTracks(tracks, { fallbackToLongest: true });

      expect(result.mainTracks).toHaveLength(1);
      expect(result.mainTracks[0].name).toBe('Track B');
    });

    it('should not fall back when fallbackToLongest is false', () => {
      const tracks = [
        { name: 'Track A', points: mockPoints(10) },
        { name: 'Track B', points: mockPoints(100) },
      ];

      const result = classifyTracks(tracks, { fallbackToLongest: false });

      expect(result.mainTracks).toHaveLength(0);
      expect(result.unclassifiedTracks).toHaveLength(2);
    });

    it('should default fallbackToLongest to true', () => {
      const tracks = [{ name: 'Unknown', points: mockPoints(100) }];

      const result = classifyTracks(tracks, {});

      expect(result.mainTracks).toHaveLength(1);
    });
  });

  describe('edge cases', () => {
    it('should handle empty tracks array', () => {
      const result = classifyTracks([], {});

      expect(result.mainTracks).toHaveLength(0);
      expect(result.alternateTracks).toHaveLength(0);
    });

    it('should handle tracks with empty names', () => {
      const tracks = [
        { name: '', points: mockPoints(50) },
        { name: 'Map 1A', points: mockPoints(30) },
      ];
      const config: TrackClassificationConfig = {
        mainRoutePatterns: ['^Map \\d+[A-D]$'],
      };

      const result = classifyTracks(tracks, config);

      expect(result.mainTracks).toHaveLength(1);
      expect(result.unclassifiedTracks).toHaveLength(1);
    });

    it('should handle invalid regex patterns gracefully', () => {
      const tracks = [{ name: 'Test', points: mockPoints(10) }];
      const config: TrackClassificationConfig = {
        mainRoutePatterns: ['[invalid(regex'],
      };

      // Should not throw, should treat as unmatched
      expect(() => classifyTracks(tracks, config)).not.toThrow();
    });

    it('should apply patterns in order: ignore > main > alternate > sideTrip', () => {
      const tracks = [
        { name: 'Alt Spur Route', points: mockPoints(20) }, // Matches both alt and spur
      ];
      const config: TrackClassificationConfig = {
        alternatePatterns: ['Alt'],
        sideTripPatterns: ['Spur'],
      };

      const result = classifyTracks(tracks, config);

      // Should be classified as alternate (checked before sideTrip)
      expect(result.alternateTracks).toHaveLength(1);
      expect(result.sideTripTracks).toHaveLength(0);
    });
  });
});

describe('combineTracksGeographically', () => {
  it('should order tracks by geographic proximity', () => {
    // Create tracks that form a chain: A--B--C
    const trackA = {
      name: 'Map 1A',
      points: [
        { lat: -34.0, lon: 138.0, ele: 100, time: null },
        { lat: -34.1, lon: 138.1, ele: 100, time: null },
      ],
    };
    const trackC = {
      name: 'Map 1C',
      points: [
        { lat: -34.3, lon: 138.3, ele: 100, time: null },
        { lat: -34.4, lon: 138.4, ele: 100, time: null },
      ],
    };
    const trackB = {
      name: 'Map 1B',
      points: [
        { lat: -34.1, lon: 138.1, ele: 100, time: null }, // Connects to end of A
        { lat: -34.3, lon: 138.3, ele: 100, time: null }, // Connects to start of C
      ],
    };

    const result = combineTracksGeographically([trackA, trackC, trackB]);

    expect(result.orderedNames).toEqual(['Map 1A', 'Map 1B', 'Map 1C']);
    expect(result.combinedPoints).toHaveLength(6);
  });

  it('should warn about gaps larger than 100m between tracks', () => {
    const trackA = {
      name: 'Track A',
      points: [
        { lat: -34.0, lon: 138.0, ele: 100, time: null },
        { lat: -34.1, lon: 138.1, ele: 100, time: null },
      ],
    };
    const trackB = {
      name: 'Track B',
      points: [
        { lat: -35.0, lon: 139.0, ele: 100, time: null }, // Large gap
        { lat: -35.1, lon: 139.1, ele: 100, time: null },
      ],
    };

    const result = combineTracksGeographically([trackA, trackB]);

    expect(result.warnings).toContainEqual(
      expect.objectContaining({ type: 'gap', gapMeters: expect.any(Number) })
    );
  });

  it('should handle single track', () => {
    const track = {
      name: 'Only Track',
      points: [{ lat: -34.0, lon: 138.0, ele: 100, time: null }],
    };

    const result = combineTracksGeographically([track]);

    expect(result.orderedNames).toEqual(['Only Track']);
    expect(result.warnings).toHaveLength(0);
  });

  it('should handle empty array', () => {
    const result = combineTracksGeographically([]);

    expect(result.combinedPoints).toHaveLength(0);
    expect(result.orderedNames).toHaveLength(0);
  });

  it('should reverse track direction if needed to minimize gaps', () => {
    // Track B is backwards - end connects to end of A
    const trackA = {
      name: 'A',
      points: [
        { lat: -34.0, lon: 138.0, ele: 100, time: null },
        { lat: -34.1, lon: 138.1, ele: 100, time: null },
      ],
    };
    const trackB = {
      name: 'B',
      points: [
        { lat: -34.3, lon: 138.3, ele: 100, time: null }, // Far end
        { lat: -34.1, lon: 138.1, ele: 100, time: null }, // Connects to end of A (reversed)
      ],
    };

    const result = combineTracksGeographically([trackA, trackB]);

    // Should detect and reverse B - the point at -34.1 should come first for B
    expect(result.combinedPoints[1].lat).toBeCloseTo(-34.1);
    expect(result.combinedPoints[2].lat).toBeCloseTo(-34.1); // B's start after reversal
  });
});

describe('TRACK_CLASSIFICATION_DEFAULTS', () => {
  it('should have sensible default patterns', () => {
    expect(TRACK_CLASSIFICATION_DEFAULTS.alternatePatterns).toContain('Detour');
    expect(TRACK_CLASSIFICATION_DEFAULTS.alternatePatterns).toContain('Reroute');
    expect(TRACK_CLASSIFICATION_DEFAULTS.sideTripPatterns).toContain('Spur');
    expect(TRACK_CLASSIFICATION_DEFAULTS.sideTripPatterns).toContain('Side Trip');
    expect(TRACK_CLASSIFICATION_DEFAULTS.fallbackToLongest).toBe(true);
  });
});
