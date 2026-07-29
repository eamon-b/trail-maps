import {
  composeCheckIn,
  formatCoords,
  mapsLink,
  type CheckInInput,
} from '../check-in';

const TRAIL = 'Australian Alps Walking Track';
const GPS = { lat: -37.04449, lon: 146.96018, currentKm: 219.2 };

function base(overrides: Partial<CheckInInput> = {}): CheckInInput {
  return { trailName: TRAIL, totalKm: 688.3, units: 'km', ...overrides };
}

describe('formatCoords', () => {
  it('renders decimal degrees with hemisphere at 5 dp', () => {
    expect(formatCoords(-37.04449, 146.96018)).toBe('37.04449°S, 146.96018°E');
  });

  it('handles the northern/western hemispheres', () => {
    expect(formatCoords(48.1, -122.7)).toBe('48.10000°N, 122.70000°W');
  });
});

describe('mapsLink', () => {
  it('builds a signed 5 dp Google Maps query', () => {
    expect(mapsLink(-37.04449, 146.96018)).toBe(
      'https://maps.google.com/?q=-37.04449,146.96018',
    );
  });
});

describe('composeCheckIn — position (guide) variant', () => {
  it('composes a position check-in', () => {
    const { title, message } = composeCheckIn(base({ gps: GPS }));
    expect(title).toBe('Check-in on Australian Alps Walking Track');
    expect(message).toBe(
      'Checking in from Australian Alps Walking Track — 219.2 km of 688.3 km. Position: 37.04449°S, 146.96018°E.\n' +
        'https://maps.google.com/?q=-37.04449,146.96018\n' +
        '(via Tracknotes)',
    );
  });

  it('adds an off-trail marker', () => {
    const { message } = composeCheckIn(base({ gps: { ...GPS, offTrail: true } }));
    expect(message).toBe(
      'Checking in from Australian Alps Walking Track (off trail) — 219.2 km of 688.3 km. Position: 37.04449°S, 146.96018°E.\n' +
        'https://maps.google.com/?q=-37.04449,146.96018\n' +
        '(via Tracknotes)',
    );
  });

  it('renders miles when units are imperial', () => {
    const { message } = composeCheckIn(base({ gps: GPS, units: 'mi' }));
    expect(message).toContain('— 136.2 mi of 427.7 mi.');
  });
});

describe('composeCheckIn — waypoint variant', () => {
  const waypoint = { name: 'Tyers River East', km: 13.2, lat: -37.12345, lon: 146.54321 };

  it('uses the live GPS fix for the readout and link when available', () => {
    const { title, message } = composeCheckIn(base({ waypoint, gps: GPS }));
    expect(title).toBe('Check-in at Tyers River East');
    expect(message).toBe(
      'Checking in at Tyers River East (13.2 km) on Australian Alps Walking Track. Position: 37.04449°S, 146.96018°E.\n' +
        'https://maps.google.com/?q=-37.04449,146.96018\n' +
        '(via Tracknotes)',
    );
  });

  it('falls back to the waypoint coordinates without a fix', () => {
    const { message } = composeCheckIn(base({ waypoint }));
    expect(message).toBe(
      'Checking in at Tyers River East (13.2 km) on Australian Alps Walking Track.\n' +
        'https://maps.google.com/?q=-37.12345,146.54321\n' +
        '(via Tracknotes)',
    );
  });
});

describe('composeCheckIn — user message', () => {
  it('inserts a trimmed note between the sentence and the link', () => {
    const { message } = composeCheckIn(base({ gps: GPS, message: '  water flowing  ' }));
    expect(message).toBe(
      'Checking in from Australian Alps Walking Track — 219.2 km of 688.3 km. Position: 37.04449°S, 146.96018°E.\n' +
        'water flowing\n' +
        'https://maps.google.com/?q=-37.04449,146.96018\n' +
        '(via Tracknotes)',
    );
  });

  it('omits an empty/whitespace note', () => {
    const { message } = composeCheckIn(base({ gps: GPS, message: '   ' }));
    expect(message).not.toContain('\n\n');
    expect(message.split('\n')).toHaveLength(3);
  });
});
