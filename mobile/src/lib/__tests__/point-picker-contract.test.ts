import {
  buildPickerParams,
  parsePickerRequest,
  buildSinglePointResultParams,
  parseSinglePointResult,
  createPickerRequestId,
  type PickerRequest,
} from '../point-picker-contract';

describe('point-picker contract', () => {
  describe('request round-trip', () => {
    it('round-trips a single-point request', () => {
      const request: PickerRequest = {
        mode: 'single',
        trailId: 'bibbulmun',
        target: 'end',
        pickerRequestId: 'pick-abc',
        returnTo: '/plan/measure',
      };
      const parsed = parsePickerRequest(buildPickerParams(request));
      expect(parsed).toMatchObject(request);
    });

    it('round-trips a section request with a preselected range', () => {
      const request: PickerRequest = {
        mode: 'section',
        trailId: 'heysen',
        planId: 'plan-1',
        direction: 'SOBO',
        currentStartKm: 12.5,
        currentEndKm: 240,
      };
      const parsed = parsePickerRequest(buildPickerParams(request));
      expect(parsed).toMatchObject(request);
    });

    it('round-trips a relocate request', () => {
      const request: PickerRequest = {
        mode: 'relocate',
        trailId: 'bibbulmun',
        planId: 'plan-1',
        stopId: 'stop-9',
        currentKm: 88.3,
      };
      const parsed = parsePickerRequest(buildPickerParams(request));
      expect(parsed).toMatchObject(request);
    });

    it('round-trips a day-view request', () => {
      const request: PickerRequest = {
        mode: 'day',
        trailId: 'bibbulmun',
        planId: 'plan-1',
        highlightStartKm: 10,
        highlightEndKm: 32.4,
        dayLabel: 'Day 2',
      };
      const parsed = parsePickerRequest(buildPickerParams(request));
      expect(parsed).toMatchObject(request);
    });

    it('rejects unknown modes and missing trailId', () => {
      expect(parsePickerRequest({ mode: 'sketch', trailId: 't' })).toBeNull();
      expect(parsePickerRequest({ mode: 'single' })).toBeNull();
    });

    it('takes the first value of array params (router duplicates)', () => {
      const parsed = parsePickerRequest({
        mode: ['add', 'single'],
        trailId: ['bibbulmun'],
      });
      expect(parsed?.mode).toBe('add');
      expect(parsed?.trailId).toBe('bibbulmun');
    });
  });

  describe('single-point result round-trip', () => {
    it('round-trips a result for a matching request id', () => {
      const id = createPickerRequestId();
      const params = buildSinglePointResultParams(id, {
        target: 'start',
        km: 42.7,
        name: 'Monadnocks Camp',
      });
      const result = parseSinglePointResult(params, id);
      expect(result).toEqual({ target: 'start', km: 42.7, name: 'Monadnocks Camp' });
    });

    it('ignores results whose id does not match the issued request', () => {
      const params = buildSinglePointResultParams('pick-old', {
        target: 'end',
        km: 5,
        name: 'X',
      });
      expect(parseSinglePointResult(params, 'pick-current')).toBeNull();
      expect(parseSinglePointResult(params, null)).toBeNull();
    });

    it('returns null when no result params are present', () => {
      expect(parseSinglePointResult({ trailId: 'bibbulmun' }, 'pick-1')).toBeNull();
    });

    it('falls back to a km label when the name is missing', () => {
      const params = buildSinglePointResultParams('id-1', { target: 'start', km: 12.34, name: '' });
      delete (params as Record<string, string | undefined>).pickerName;
      const result = parseSinglePointResult(params, 'id-1');
      expect(result?.name).toBe('km 12.3');
    });

    it('mints unique request ids', () => {
      const ids = new Set(Array.from({ length: 50 }, () => createPickerRequestId()));
      expect(ids.size).toBe(50);
    });
  });
});
