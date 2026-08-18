import { emitSyncChange, onSyncChange, type SyncChange } from '../sync-events';

describe('sync-events', () => {
  it('delivers emitted changes to a subscriber', () => {
    const seen: SyncChange[] = [];
    const unsub = onSyncChange((c) => seen.push(c));
    emitSyncChange({ trailId: 'heysen', waypointIds: ['w_1'] });
    expect(seen).toEqual([{ trailId: 'heysen', waypointIds: ['w_1'] }]);
    unsub();
  });

  it('fans out to every subscriber', () => {
    const a = jest.fn();
    const b = jest.fn();
    const unsubA = onSyncChange(a);
    const unsubB = onSyncChange(b);
    emitSyncChange({ trailId: 't' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    unsubA();
    unsubB();
  });

  it('stops delivering after unsubscribe', () => {
    const fn = jest.fn();
    const unsub = onSyncChange(fn);
    unsub();
    emitSyncChange({ trailId: 't' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('defaults to an empty change object', () => {
    let received: SyncChange | undefined;
    const unsub = onSyncChange((c) => {
      received = c;
    });
    emitSyncChange();
    expect(received).toEqual({});
    unsub();
  });

  it('tolerates a subscriber that unsubscribes during dispatch', () => {
    const order: string[] = [];
    const unsubSelf = onSyncChange(() => {
      order.push('self');
      unsubSelf();
    });
    const unsubOther = onSyncChange(() => order.push('other'));
    // Both fire on this emit; the mid-dispatch removal must not skip 'other'.
    emitSyncChange();
    expect(order).toEqual(['self', 'other']);
    // 'self' removed itself, so a second emit only reaches 'other'.
    emitSyncChange();
    expect(order).toEqual(['self', 'other', 'other']);
    unsubOther();
  });
});
