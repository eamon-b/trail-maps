import { createMigratedTestDb } from './test-helpers';
import type { SqlDatabase } from '../sql-database';
import * as outboxRepo from '../outbox-repo';

async function db(): Promise<SqlDatabase> {
  return (await createMigratedTestDb()) as unknown as SqlDatabase;
}

describe('outbox-repo', () => {
  it('enqueues and lists items in FIFO (created_at) order', async () => {
    const d = await db();
    await outboxRepo.enqueue(d, {
      id: 'b',
      kind: 'comment',
      payload: { n: 2 },
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    await outboxRepo.enqueue(d, {
      id: 'a',
      kind: 'comment',
      payload: { n: 1 },
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const list = await outboxRepo.listPending(d);
    expect(list.map((i) => i.id)).toEqual(['a', 'b']);
    expect(JSON.parse(list[0].payloadJson)).toEqual({ n: 1 });
  });

  it('round-trips status transitions and attempt counting', async () => {
    const d = await db();
    await outboxRepo.enqueue(d, { id: 'x', kind: 'comment', payload: {} });

    await outboxRepo.markSending(d, 'x');
    expect((await outboxRepo.getById(d, 'x'))?.status).toBe('sending');

    await outboxRepo.markFailed(d, 'x', 'invalid_text: too long');
    let item = await outboxRepo.getById(d, 'x');
    expect(item?.status).toBe('failed');
    expect(item?.attempts).toBe(1);
    expect(item?.lastError).toBe('invalid_text: too long');

    await outboxRepo.markFailed(d, 'x', 'again');
    expect((await outboxRepo.getById(d, 'x'))?.attempts).toBe(2);

    await outboxRepo.markPending(d, 'x');
    item = await outboxRepo.getById(d, 'x');
    expect(item?.status).toBe('pending');
    expect(item?.attempts).toBe(2); // markPending does not reset attempts
  });

  it('re-enqueue resets attempts/error and clears the failed state', async () => {
    const d = await db();
    await outboxRepo.enqueue(d, { id: 'x', kind: 'comment', payload: { a: 1 } });
    await outboxRepo.markFailed(d, 'x', 'boom');
    await outboxRepo.enqueue(d, { id: 'x', kind: 'delete', payload: { id: 'x' } });
    const item = await outboxRepo.getById(d, 'x');
    expect(item).toMatchObject({ kind: 'delete', attempts: 0, status: 'pending', lastError: null });
  });

  it('removes items and counts', async () => {
    const d = await db();
    await outboxRepo.enqueue(d, { id: '1', kind: 'comment', payload: {} });
    await outboxRepo.enqueue(d, { id: '2', kind: 'comment', payload: {} });
    expect(await outboxRepo.count(d)).toBe(2);
    await outboxRepo.remove(d, '1');
    expect(await outboxRepo.count(d)).toBe(1);
    expect(await outboxRepo.getById(d, '1')).toBeNull();
  });
});
