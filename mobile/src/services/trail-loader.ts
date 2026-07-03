import { TrailDataService, type Trail } from './trail-data-service';
import { registerClimateData, type ClimateData } from './climate-service';

interface TrailIndex {
  id: string;
  name: string;
  shortName: string;
  lengthKm: number;
  dataVersion?: string;
}

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

// Metro resolves require() for JSON files to the parsed object at build time
const trailIndex: TrailIndex[] = require('../../assets/trails/index.json');
export const TRAIL_DATA: Record<string, TrailJson> = {
  aawt: require('../../assets/trails/aawt.json'),
  'hume-and-hovell': require('../../assets/trails/hume-and-hovell.json'),
  bibbulmun: require('../../assets/trails/bibbulmun.json'),
  cape_to_cape: require('../../assets/trails/cape_to_cape.json'),
  heysen: require('../../assets/trails/heysen.json'),
  larapinta: require('../../assets/trails/larapinta.json'),
};

export async function loadBundledTrails(service: TrailDataService): Promise<void> {
  const index = trailIndex;

  for (const entry of index) {
    const trailJson = TRAIL_DATA[entry.id];
    if (!trailJson) continue;

    const existing = await service.getTrail(entry.id);
    const bundledVersion = entry.dataVersion ?? null;

    // Skip if already imported and version hasn't changed
    if (existing && existing.dataVersion === bundledVersion) continue;

    const config = trailJson.config;

    const trail: Omit<Trail, 'createdAt' | 'updatedAt'> = {
      id: config.id,
      name: config.name,
      shortName: config.shortName,
      region: config.region,
      lengthKm: config.lengthKm,
      dataVersion: bundledVersion,
      isCustom: false,
      sourceFilename: null,
      metadataJson: JSON.stringify({
        direction: config.direction,
        track: {
          totalDistance: trailJson.track.totalDistance,
          totalAscent: trailJson.track.totalAscent,
          totalDescent: trailJson.track.totalDescent,
          displayPointCount: trailJson.track.displayPoints.length,
        },
      }),
    };

    await service.storeTrail(trail);

    const waypoints = trailJson.waypoints.map((wp) => ({
      name: wp.name,
      type: wp.type,
      lat: wp.lat,
      lon: wp.lon,
      ele: wp.elevation ?? null,
      kmPosition: wp.totalDistance ?? null,
      description: wp.description ?? null,
    }));

    await service.storeWaypoints(config.id, waypoints);

    // Register climate data if available
    const climate = (trailJson as Record<string, unknown>).climate as ClimateData | undefined;
    if (climate?.locations && climate.dataYears) {
      registerClimateData(entry.id, climate);
    }
  }
}
