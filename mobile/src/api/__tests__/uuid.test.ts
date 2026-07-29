import { uuidv4 } from '../uuid';

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidv4', () => {
  it('mints a well-formed lowercase UUID v4', () => {
    for (let i = 0; i < 200; i++) {
      expect(uuidv4()).toMatch(UUID_V4_RE);
    }
  });

  it('is (practically) collision-free across calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(uuidv4());
    expect(seen.size).toBe(1000);
  });
});
