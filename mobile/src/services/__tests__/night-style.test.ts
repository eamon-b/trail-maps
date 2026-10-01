import { applyNightPalette, nightColor, nightLayer, parseColor } from '../night-style';

const lightness = (color: string) => parseColor(color)!.l;
const hue = (color: string) => parseColor(color)!.h;

describe('parseColor', () => {
  it.each([
    ['#fff', 1],
    ['#f8f4f0', 0.96],
    ['rgb(158,189,255)', 0.81],
    ['rgba(176, 213, 154, 1)', 0.72],
    ['hsl(0,0%,100%)', 1],
    ['hsla(98,61%,72%,0.7)', 0.72],
    ['white', 1],
  ])('reads %s', (input, l) => {
    expect(parseColor(input)!.l).toBeCloseTo(l, 2);
  });

  it('keeps alpha', () => {
    expect(parseColor('hsla(35,57%,88%,0.49)')!.a).toBeCloseTo(0.49);
    expect(parseColor('#00000080')!.a).toBeCloseTo(0.5, 2);
  });

  it.each(['zoom', 'name', 'Noto Sans Regular', '#ggg', 'rgb(1,2)'])('rejects %s', (input) => {
    expect(parseColor(input)).toBeNull();
  });
});

describe('nightColor', () => {
  it('inverts areas: the cream ground goes dark, landcover lands just above it', () => {
    const ground = lightness(nightColor('#f8f4f0', 'area'));
    const forest = lightness(nightColor('hsla(98,61%,72%,0.7)', 'area'));
    expect(ground).toBeLessThan(0.2);
    expect(forest).toBeGreaterThan(ground);
    expect(forest).toBeLessThan(0.3);
  });

  it('keeps lines in order: a white road stays lighter than a yellow one, both above the ground', () => {
    const ground = lightness(nightColor('#f8f4f0', 'area'));
    const white = lightness(nightColor('#fff', 'line'));
    const yellow = lightness(nightColor('#fea', 'line'));
    expect(white).toBeGreaterThan(yellow);
    expect(yellow).toBeGreaterThan(ground + 0.3);
  });

  it('turns dark text light and white halos dark', () => {
    expect(lightness(nightColor('#333', 'text'))).toBeGreaterThan(0.8);
    expect(lightness(nightColor('#fff', 'halo'))).toBeLessThan(0.15);
  });

  it('never moves the hue', () => {
    for (const c of ['rgb(158,189,255)', '#aed1a0', '#e9ac77']) {
      expect(hue(nightColor(c, 'area'))).toBeCloseTo(hue(c), 0);
    }
  });

  it('lets water keep more saturation than land', () => {
    const water = parseColor(nightColor('rgb(158,189,255)', 'area'))!;
    const grass = parseColor(nightColor('rgb(176, 213, 154)', 'area'))!;
    expect(water.s).toBeGreaterThan(grass.s);
  });

  it('keeps alpha and leaves non-colours alone', () => {
    expect(parseColor(nightColor('hsla(35,57%,88%,0.49)', 'area'))!.a).toBeCloseTo(0.49);
    expect(nightColor('zoom', 'area')).toBe('zoom');
  });
});

describe('nightLayer', () => {
  it('repaints colours inside expressions but not their other strings', () => {
    const layer = nightLayer({
      id: 'road_motorway',
      type: 'line',
      paint: {
        'line-color': ['interpolate', ['linear'], ['zoom'], 5, 'hsl(26,87%,62%)', 6, '#fc8'],
        'line-width': 2,
      },
    });
    const expr = layer.paint!['line-color'] as unknown[];
    expect(expr.slice(0, 3)).toEqual(['interpolate', ['linear'], ['zoom']]);
    expect(expr[4]).not.toBe('hsl(26,87%,62%)');
    expect(expr[6]).not.toBe('#fc8');
    expect(layer.paint!['line-width']).toBe(2);
  });

  it('repaints legacy stop functions', () => {
    const layer = nightLayer({
      id: 'x',
      type: 'fill',
      paint: { 'fill-color': { stops: [[5, '#fff'], [10, '#000']] } },
    });
    const stops = (layer.paint!['fill-color'] as { stops: [number, string][] }).stops;
    expect(stops[0][0]).toBe(5);
    expect(lightness(stops[0][1])).toBeLessThan(0.2);
  });

  it('dims raster relief and fades sprite patterns', () => {
    const relief = nightLayer({ id: 'ne', type: 'raster', paint: {} as Record<string, unknown> });
    expect(relief.paint!['raster-brightness-max']).toBeLessThan(0.5);
    expect(
      nightLayer({ id: 'w', type: 'fill', paint: { 'fill-pattern': 'wetland', 'fill-opacity': 0.8 } }).paint![
        'fill-opacity'
      ],
    ).toBeCloseTo(0.28);
  });

  it('does not mutate its input', () => {
    const layer = { id: 'bg', type: 'background', paint: { 'background-color': '#f8f4f0' } };
    nightLayer(layer);
    expect(layer.paint['background-color']).toBe('#f8f4f0');
  });

  it('applies to a layer with no paint block', () => {
    const style = { layers: [{ id: 'label', type: 'symbol' }] };
    applyNightPalette(style);
    expect(style.layers[0]).toEqual({ id: 'label', type: 'symbol', paint: {} });
  });
});
