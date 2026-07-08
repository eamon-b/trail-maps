import {
  pickClimateSamplePoints,
  ensureCustomTrailClimate,
  loadCachedCustomTrailClimate,
  DATA_START_YEAR,
  DATA_END_YEAR,
} from '../custom-climate-service';
import { loadClimateData, type ClimateData } from '../climate-service';
import { TrailDataService } from '../trail-data-service';

jest.mock('../trail-data-service', () => ({
  TrailDataService: { create: jest.fn() },
}));

const mockCreate = TrailDataService.create as jest.Mock;

function mockService(overrides: Partial<Record<'getClimateJson' | 'storeClimateJson', jest.Mock>> = {}) {
  const service = {
    getClimateJson: jest.fn().mockResolvedValue(null),
    storeClimateJson: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  mockCreate.mockResolvedValue(service);
  return service;
}

/** Build a straight track with points every `stepKm` up to `totalKm`. */
function buildTrack(totalKm: number, stepKm = 1) {
  const points = [];
  for (let d = 0; d <= totalKm; d += stepKm) {
    points.push({ lat: -35 - d * 0.01, lon: 148 + d * 0.01, dist: d });
  }
  return points;
}

function sampleClimateData(): ClimateData {
  return {
    locations: [
      {
        name: 'km 0',
        lat: -35,
        lon: 148,
        elevation: 500,
        distanceAlongTrail: 0,
        monthly: Array.from({ length: 12 }, (_, i) => ({
          month: i + 1,
          avgTempMin: 5,
          avgTempMax: 20,
          avgPrecipitation: 50,
          avgRainyDays: 6,
        })),
      },
    ],
    dataYears: { start: DATA_START_YEAR, end: DATA_END_YEAR },
  };
}

/** A minimal successful Open-Meteo archive response. */
function archiveResponse() {
  return {
    ok: true,
    json: async () => ({
      elevation: 812.5,
      daily: {
        time: ['2020-01-01', '2020-01-02'],
        temperature_2m_max: [30, 32],
        temperature_2m_min: [15, 17],
        precipitation_sum: [0, 4],
      },
    }),
  };
}

describe('pickClimateSamplePoints', () => {
  it('returns just the two endpoints for a short trail', () => {
    const points = buildTrack(50);
    const samples = pickClimateSamplePoints(points, 50);

    expect(samples).toHaveLength(2);
    expect(samples[0].name).toBe('km 0');
    expect(samples[0].distanceAlongTrail).toBe(0);
    expect(samples[0].lat).toBe(points[0].lat);
    expect(samples[1].name).toBe('km 50');
    expect(samples[1].distanceAlongTrail).toBe(50);
    expect(samples[1].lat).toBe(points[points.length - 1].lat);
  });

  it('caps a 500 km trail at 5 sample points', () => {
    const samples = pickClimateSamplePoints(buildTrack(500), 500);

    expect(samples).toHaveLength(5);
    expect(samples.map((s) => s.name)).toEqual([
      'km 0',
      'km 125',
      'km 250',
      'km 375',
      'km 500',
    ]);
  });

  it('adds interior points roughly every 100 km', () => {
    const samples = pickClimateSamplePoints(buildTrack(312), 312);

    expect(samples).toHaveLength(4);
    expect(samples.map((s) => s.name)).toEqual(['km 0', 'km 104', 'km 208', 'km 312']);
  });

  it('handles a single-point track', () => {
    const samples = pickClimateSamplePoints([{ lat: -35, lon: 148, dist: 0 }], 0);
    expect(samples).toEqual([
      { name: 'km 0', lat: -35, lon: 148, distanceAlongTrail: 0 },
    ]);
  });

  it('returns empty for an empty track', () => {
    expect(pickClimateSamplePoints([], 0)).toEqual([]);
  });
});

describe('ensureCustomTrailClimate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (global.fetch as unknown) = jest.fn();
  });

  it('returns cached climate without hitting the network', async () => {
    const cached = sampleClimateData();
    const service = mockService({
      getClimateJson: jest.fn().mockResolvedValue(JSON.stringify(cached)),
    });

    const trail = { track: { points: buildTrack(50), totalDistance: 50 } };
    const data = await ensureCustomTrailClimate('custom-1', trail);

    expect(data).toEqual(cached);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(service.storeClimateJson).not.toHaveBeenCalled();
    // Registered with the in-memory climate service
    expect(loadClimateData('custom-1')).toEqual(cached);
  });

  it('fetches, persists, and registers climate on cache miss', async () => {
    const service = mockService();
    (global.fetch as jest.Mock).mockResolvedValue(archiveResponse());

    // Single-point track → one sample location, no inter-request delay
    const trail = { track: { points: [{ lat: -35, lon: 148, dist: 0 }], totalDistance: 0 } };
    const data = await ensureCustomTrailClimate('custom-2', trail);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('archive-api.open-meteo.com/v1/archive');
    expect(url).toContain(`start_date=${DATA_START_YEAR}-01-01`);
    expect(url).toContain(`end_date=${DATA_END_YEAR}-12-31`);

    expect(data).not.toBeNull();
    expect(data!.dataYears).toEqual({ start: DATA_START_YEAR, end: DATA_END_YEAR });
    expect(data!.locations).toHaveLength(1);
    expect(data!.locations[0].name).toBe('km 0');
    expect(data!.locations[0].elevation).toBe(813);
    expect(data!.locations[0].monthly).toHaveLength(12);
    // January aggregated from the two daily rows
    expect(data!.locations[0].monthly[0]).toEqual({
      month: 1,
      avgTempMin: 16,
      avgTempMax: 31,
      avgPrecipitation: 4,
      avgRainyDays: 1,
    });

    expect(service.storeClimateJson).toHaveBeenCalledWith('custom-2', JSON.stringify(data));
    expect(loadClimateData('custom-2')).toEqual(data);
  });

  it('returns null and persists nothing when the fetch fails', async () => {
    const service = mockService();
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'server error',
    });

    const trail = { track: { points: [{ lat: -35, lon: 148, dist: 0 }], totalDistance: 0 } };
    const data = await ensureCustomTrailClimate('custom-3', trail);

    expect(data).toBeNull();
    expect(service.storeClimateJson).not.toHaveBeenCalled();
    expect(loadClimateData('custom-3')).toBeNull();
    // One retry after the initial attempt
    expect(global.fetch).toHaveBeenCalledTimes(2);
  }, 10000);
});

describe('loadCachedCustomTrailClimate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (global.fetch as unknown) = jest.fn();
  });

  it('returns null when nothing is cached', async () => {
    mockService();
    expect(await loadCachedCustomTrailClimate('custom-4')).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns null for invalid cached JSON', async () => {
    mockService({ getClimateJson: jest.fn().mockResolvedValue('not-json{') });
    expect(await loadCachedCustomTrailClimate('custom-5')).toBeNull();
  });

  it('registers and returns valid cached climate', async () => {
    const cached = sampleClimateData();
    mockService({ getClimateJson: jest.fn().mockResolvedValue(JSON.stringify(cached)) });

    const data = await loadCachedCustomTrailClimate('custom-6');
    expect(data).toEqual(cached);
    expect(loadClimateData('custom-6')).toEqual(cached);
  });
});
