/**
 * Bundled trail assets and their serialized shape.
 *
 * Keep this module free of service imports. The trail loader needs the bundled
 * JSON, and keeping the require() map isolated here avoids runtime import cycles
 * through other services.
 */

export interface TrailJson {
  config: {
    id: string;
    name: string;
    shortName: string;
    region: string;
    lengthKm: number;
    direction: { default: string; reversed: string };
    [key: string]: unknown;
  };
  waypoints: {
    /** Stable per-waypoint id baked into bundled data (e.g. "w_766c3fd2"). */
    id?: string;
    name: string;
    lat: number;
    lon: number;
    type: string;
    description?: string;
    elevation?: number;
    distance?: number;
    totalDistance?: number;
    ascent?: number;
    descent?: number;
    totalAscent?: number;
    totalDescent?: number;
  }[];
  track: {
    points: { lat: number; lon: number; ele: number; dist: number }[];
    displayPoints: { lat: number; lon: number; ele: number; dist: number }[];
    totalDistance: number;
    totalAscent: number;
    totalDescent: number;
  };
  [key: string]: unknown;
}

// Metro resolves require() for JSON files to the parsed object at build time.
export const TRAIL_DATA: Record<string, TrailJson> = {
  aawt: require('../../assets/trails/aawt.json'),
  'hume-and-hovell': require('../../assets/trails/hume-and-hovell.json'),
  bibbulmun: require('../../assets/trails/bibbulmun.json'),
  cape_to_cape: require('../../assets/trails/cape_to_cape.json'),
  heysen: require('../../assets/trails/heysen.json'),
  larapinta: require('../../assets/trails/larapinta.json'),
};
