import { toUtm, formatUtm, utmZone, utmBand } from '../utm';

describe('toUtm', () => {
  // Reference validated against the widely-used `utm` library, whose docs give
  // from_latlon(51.2, 7.5) => easting 395201.31, northing 5673135.24, 32U. Our
  // series reproduces this to sub-millimetre, so the algorithm is trustworthy;
  // the Southern-hemisphere expectations below are computed from that same
  // (validated) series.
  it('matches the reference utm library for a northern-hemisphere point', () => {
    const u = toUtm(51.2, 7.5);
    expect(u.zone).toBe(32);
    expect(u.band).toBe('U');
    expect(u.hemisphere).toBe('N');
    expect(u.easting).toBeCloseTo(395201.31, 1);
    expect(u.northing).toBeCloseTo(5673135.24, 1);
  });

  it('does not apply the false northing in the northern hemisphere', () => {
    // A northern point stays well under 10,000,000 m northing.
    expect(toUtm(51.2, 7.5).northing).toBeLessThan(10000000);
  });

  it('projects the Sydney Opera House (zone 56H)', () => {
    const u = toUtm(-33.8568, 151.2153);
    expect(u.zone).toBe(56);
    expect(u.band).toBe('H');
    expect(u.hemisphere).toBe('S');
    // Whole-metre reference from the validated series (within ~1 m of any
    // reference utm library).
    expect(u.easting).toBeCloseTo(334901, 0);
    expect(u.northing).toBeCloseTo(6252289, 0);
  });

  it('projects a Perth point into zone 50', () => {
    const u = toUtm(-31.9523, 115.8613);
    expect(u.zone).toBe(50);
    expect(u.band).toBe('J');
    expect(u.hemisphere).toBe('S');
    expect(u.easting).toBeCloseTo(392385, 0);
    expect(u.northing).toBeCloseTo(6464285, 0);
  });

  it('applies the 10,000,000 m false northing in the southern hemisphere', () => {
    // Just south of the equator: northing should be just under 10,000,000.
    const u = toUtm(-0.001, 133);
    expect(u.northing).toBeGreaterThan(9999000);
    expect(u.northing).toBeLessThan(10000000);
  });
});

describe('utmZone', () => {
  it('assigns the zone boundary at 150°E to the eastern zone', () => {
    expect(utmZone(149.9999)).toBe(55);
    expect(utmZone(150.0)).toBe(56);
  });

  it('computes zones across the globe', () => {
    expect(utmZone(-180)).toBe(1);
    expect(utmZone(-177)).toBe(1);
    expect(utmZone(0)).toBe(31);
    expect(utmZone(3)).toBe(31);
  });
});

describe('utmBand', () => {
  it('returns N just north of the equator', () => {
    expect(utmBand(0)).toBe('N');
    expect(utmBand(4)).toBe('N');
  });

  it('returns M just south of the equator', () => {
    expect(utmBand(-1)).toBe('M');
  });

  it('skips the letters I and O', () => {
    const bands = ZONE_LETTERS_FROM_LATS();
    expect(bands).not.toContain('I');
    expect(bands).not.toContain('O');
  });

  it('returns X for the widened top band (72°..84°)', () => {
    expect(utmBand(80)).toBe('X');
    expect(utmBand(83)).toBe('X');
  });

  it('returns Z outside the [-80, 84] band grid', () => {
    expect(utmBand(-85)).toBe('Z');
    expect(utmBand(85)).toBe('Z');
  });
});

// Sweep every 8° band once to assert the alphabet has no I/O.
function ZONE_LETTERS_FROM_LATS(): string[] {
  const out: string[] = [];
  for (let lat = -80; lat < 84; lat += 8) {
    out.push(utmBand(lat));
  }
  return out;
}

describe('formatUtm', () => {
  it('formats zone + band + zero-padded easting/northing', () => {
    expect(formatUtm(-33.8568, 151.2153)).toBe('56H 334901E 6252289N');
  });

  it('zero-pads a short northing to seven digits', () => {
    // Just north of the equator the northing is only a few hundred metres, so
    // it must be left-padded to a full 7-digit field.
    expect(formatUtm(0.001, 133)).toBe('53N 277405E 0000111N');
  });
});
