/**
 * Tests for the shared delete-with-undo lifecycle: deferred photo cleanup,
 * displacement of a still-pending row, unmount cleanup, and the undo-vs-expiry
 * mutual exclusivity that prevents a dangling photo_uri.
 */
import { renderHook, act } from '@testing-library/react-native';

import { useWaypointDeleteUndo } from '../useWaypointDeleteUndo';

const mockDeletePhoto = jest.fn();
jest.mock('../../services/waypoint-photo-service', () => ({
  deleteWaypointPhoto: (...args: unknown[]) => mockDeletePhoto(...args),
}));

type Row = { id: string; photoUri?: string | null };
const rowA: Row = { id: 'a', photoUri: '/p/a.jpg' };
const rowB: Row = { id: 'b', photoUri: '/p/b.jpg' };

beforeEach(() => jest.clearAllMocks());

describe('useWaypointDeleteUndo', () => {
  it('undo restores the row and never deletes its photo', async () => {
    const onRestore = jest.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useWaypointDeleteUndo<Row>(onRestore));

    act(() => result.current.registerDeleted(rowA));
    expect(result.current.deleted).toEqual(rowA);

    await act(async () => { await result.current.undo(); });

    expect(onRestore).toHaveBeenCalledWith(rowA);
    expect(mockDeletePhoto).not.toHaveBeenCalled();
    expect(result.current.deleted).toBeNull();
  });

  it('expiry deletes the photo and never restores', () => {
    const onRestore = jest.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useWaypointDeleteUndo<Row>(onRestore));

    act(() => result.current.registerDeleted(rowA));
    act(() => result.current.expire());

    expect(mockDeletePhoto).toHaveBeenCalledWith('/p/a.jpg');
    expect(onRestore).not.toHaveBeenCalled();
    expect(result.current.deleted).toBeNull();
  });

  it('is a no-op when undo loses the race to expiry (no restore of a photoless row)', async () => {
    const onRestore = jest.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useWaypointDeleteUndo<Row>(onRestore));

    act(() => result.current.registerDeleted(rowA));
    act(() => result.current.expire()); // wins first
    await act(async () => { await result.current.undo(); }); // late — no-op

    expect(onRestore).not.toHaveBeenCalled();
    expect(mockDeletePhoto).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when expiry loses the race to undo (photo preserved)', async () => {
    const onRestore = jest.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useWaypointDeleteUndo<Row>(onRestore));

    act(() => result.current.registerDeleted(rowA));
    await act(async () => { await result.current.undo(); }); // wins first
    act(() => result.current.expire()); // late — no-op

    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(mockDeletePhoto).not.toHaveBeenCalled();
  });

  it('displacing a still-pending row cleans up its photo and holds the new row', async () => {
    const onRestore = jest.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useWaypointDeleteUndo<Row>(onRestore));

    act(() => result.current.registerDeleted(rowA));
    act(() => result.current.registerDeleted(rowB)); // displaces A

    expect(mockDeletePhoto).toHaveBeenCalledWith('/p/a.jpg');
    expect(mockDeletePhoto).toHaveBeenCalledTimes(1);
    expect(result.current.deleted).toEqual(rowB);

    // Undo now restores B (A is permanently gone), and B's photo survives.
    await act(async () => { await result.current.undo(); });
    expect(onRestore).toHaveBeenCalledWith(rowB);
    expect(mockDeletePhoto).toHaveBeenCalledTimes(1);
  });

  it('does not clean up the displaced photo if the prior row was already undone', async () => {
    const onRestore = jest.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useWaypointDeleteUndo<Row>(onRestore));

    act(() => result.current.registerDeleted(rowA));
    await act(async () => { await result.current.undo(); }); // A settled (restored)
    act(() => result.current.registerDeleted(rowB)); // A must NOT be photo-deleted

    expect(mockDeletePhoto).not.toHaveBeenCalled();
    expect(result.current.deleted).toEqual(rowB);
  });

  it('cleans up a pending photo on unmount (toast timer never fires expiry)', () => {
    const onRestore = jest.fn().mockResolvedValue(undefined);
    const { result, unmount } = renderHook(() => useWaypointDeleteUndo<Row>(onRestore));

    act(() => result.current.registerDeleted(rowA));
    unmount();

    expect(mockDeletePhoto).toHaveBeenCalledWith('/p/a.jpg');
  });

  it('does not clean up on unmount when the row was already settled', async () => {
    const onRestore = jest.fn().mockResolvedValue(undefined);
    const { result, unmount } = renderHook(() => useWaypointDeleteUndo<Row>(onRestore));

    act(() => result.current.registerDeleted(rowA));
    await act(async () => { await result.current.undo(); });
    unmount();

    expect(mockDeletePhoto).not.toHaveBeenCalled();
  });
});
