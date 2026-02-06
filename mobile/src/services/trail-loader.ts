import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system';
import { TrailDataService, type Trail } from './trail-data-service';

interface TrailIndex {
  id: string;
  name: string;
  shortName: string;
  lengthKm: number;
}

interface TrailJson {
  config: {
    id: string;
    name: string;
    shortName: string;
    region: string;
    lengthKm: number;
    direction: { default: string; reversed: string };
    [key: string]: unknown;
  };
  waypoints: Array<{
    name: string;
    lat: number;
    lon: number;
    type: string;
    description?: string;
    elevation?: number;
    distance?: number;
    totalDistance?: number;
  }>;
  track: {
    points: Array<{ lat: number; lon: number; ele: number; dist: number }>;
    displayPoints: Array<{ lat: number; lon: number; ele: number; dist: number }>;
    totalDistance: number;
    totalAscent: number;
    totalDescent: number;
  };
  [key: string]: unknown;
}

const TRAIL_ASSETS: Record<string, number> = {
  index: require('../../assets/trails/index.json'),
  bibbulmum: require('../../assets/trails/bibbulmum.json'),
};

async function loadJsonAsset<T>(assetModule: number): Promise<T> {
  const [asset] = await Asset.loadAsync(assetModule);
  if (!asset.localUri) {
    throw new Error('Failed to load asset');
  }
  const content = await FileSystem.readAsStringAsync(asset.localUri);
  return JSON.parse(content) as T;
}

export async function loadBundledTrails(service: TrailDataService): Promise<void> {
  const index = await loadJsonAsset<TrailIndex[]>(TRAIL_ASSETS.index);

  for (const entry of index) {
    const assetModule = TRAIL_ASSETS[entry.id];
    if (!assetModule) continue;

    const existing = await service.getTrail(entry.id);
    if (existing) continue;

    const trailJson = await loadJsonAsset<TrailJson>(assetModule);
    const config = trailJson.config;

    const trail: Omit<Trail, 'createdAt' | 'updatedAt'> = {
      id: config.id,
      name: config.name,
      shortName: config.shortName,
      region: config.region,
      lengthKm: config.lengthKm,
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
  }
}
