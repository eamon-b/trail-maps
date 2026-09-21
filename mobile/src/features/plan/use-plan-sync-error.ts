/**
 * Why the trail's plan has not reached the server, or null.
 *
 * A plan write that the API refuses (a document over the server's size limit,
 * a second `plan_exists`) leaves its outbox row `failed` and drains no further.
 * Everything on the Plan screen still reads correctly — the document IS saved,
 * locally — so without this the only symptom is a linked browser quietly
 * showing an older plan. The row's message is read here and shown once, small,
 * under the header card.
 *
 * Re-read on every sync event, which a drain now emits for failures as well as
 * for the rows it sent, so the line appears as soon as the write gives up and
 * goes away as soon as a later one lands.
 */

import { useEffect, useState } from 'react';
import { getDatabase } from '../../db/database';
import * as outboxRepo from '../../db/outbox-repo';
import { onSyncChange } from '../../sync/sync-events';

/** What was read, and which plan it was read for. */
interface PlanFailure {
  planId: string;
  message: string;
}

/**
 * @param planId the plan's document id, or undefined before the trail has a
 *   plan at all — nothing can be queued for a document that does not exist.
 */
export function usePlanSyncError(planId: string | undefined): string | null {
  const [failure, setFailure] = useState<PlanFailure | null>(null);

  useEffect(() => {
    if (!planId) return;
    let cancelled = false;
    const read = () => {
      void getDatabase()
        .then((db) => outboxRepo.lastFailure(db, 'plan', planId))
        .then((message) => {
          if (!cancelled) setFailure(message ? { planId, message } : null);
        })
        .catch(() => {
          // A failed read of the failure queue is not worth a second banner.
        });
    };
    read();
    const unsubscribe = onSyncChange(read);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [planId]);

  // Stamped with the plan it was read for, so a document adopted under the
  // server's id (a 409 `plan_exists`) never wears the old id's failure, and a
  // trail with no plan is answered without a state write.
  return failure && failure.planId === planId ? failure.message : null;
}
