import { TrailDataService, type Trail } from './trail-data-service';
import { registerClimateData, type ClimateData } from './climate-service';
import { TRAIL_DATA } from './trail-assets';

export type { TrailJson } from './trail-assets';

interface TrailIndex {
  id: string;
  name: string;
  shortName: string;
  lengthKm: number;
  dataVersion?: string;
}

const trailIndex: TrailIndex[] = require('../../assets/trails/index.json');

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
