/**
 * Bundled trail assets and their serialized shape.
 *
 * Keep this module free of service imports. Both the database service and the
 * startup loader need the bundled JSON, and putting it in the loader created a
 * runtime cycle through climate-service.
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
