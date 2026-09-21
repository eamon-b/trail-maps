/**
 * The planner's sync arm: the Sync button, the link dialog, the Share panel,
 * and the small state machine that keeps one trail's plan document in step
 * with the server.
 *
 * It is a separate module from `plan-viewer.ts` because the viewer's job is
 * the map, the days and the stops — everything here is about a token and a
 * `PUT`. The viewer hands over three things and nothing else: the document as
 * it stands (`getPlan`), a way to take the server's copy (`adoptServerPlan`,
 * which re-renders) and a way to stamp the server's id/timestamp onto the
 * document without re-rendering or provoking another save (`stampPlan`).
 *
 * The order of operations never changes: the local `localStorage` write has
 * already happened when `onLocalSave()` is called, so a plan is never lost to
 * a flaky network — the server copy is the second write, not the first.
 *
 * Reads come before writes wherever the page may have fallen behind: at boot,
 * when the network returns, when the tab is looked at again, and before a push
 * from a page that has sat idle. There is no poll — one `GET` when there is a
 * reason for one — and nothing is ever written over the account's copy without
 * having compared against it first. `syncedUpdatedAt` is the server stamp this
 * page last saw, which is what lets `reconcile` tell an ordinary refresh from
 * a genuine two-writer conflict, and say which side of one won.
 *
 * Nothing in here runs at all unless `VITE_API_BASE_URL` was set at build
 * time; without it the buttons are removed and the planner is exactly the
 * local-only page it was before. Imported (`u_`) trails keep their plans on
 * this device, as their comments do, so they get the button with the reason
 * on it and no machinery behind it.
 */

import type { PlanDocument } from '@lib/plan-types';
import { isPlanDocument } from '@lib/plan-editor';
import { ApiError, NetworkError, getApiBase } from '../api/client';
import {
  LINK_CODE_LENGTH,
  clearSession,
  linkDevice,
  loadSession,
  normaliseLinkCode,
  thisBrowserLabel,
  unlinkThisBrowser,
  type WebSession,
} from '../api/session';
import { fetchMyPlan, putPlan, sharePlan, unsharePlan } from '../api/plans';

/** What the sync arm needs of the page it is bolted to. */
export interface PlanSyncHost {
  /** The id the plan is stored under — an `u_…` id means an imported trail. */
  trailId: string;
  /** The document as it stands right now. */
  getPlan(): PlanDocument;
  /**
   * Take the server's copy: replace the document, save it locally and
   * re-render the page (including the header inputs).
   */
  adoptServerPlan(plan: PlanDocument): void;
  /**
   * Write server-side bookkeeping (`updatedAt`, an adopted `id`) into the
   * document and save it locally. No re-render: neither field is on screen,
   * and no save is scheduled, so this can never loop back into a `PUT`.
   */
  stampPlan(patch: Partial<PlanDocument>): void;
}

export interface PlanSyncController {
  /** Called by `commitSave` once the local write has happened. */
  onLocalSave(): void;
  /** Drop listeners — the viewer can reboot with another trail. */
  destroy(): void;
}

const NO_OP: PlanSyncController = { onLocalSave() {}, destroy() {} };

/** True for an id minted by the GPX importer: its plan never leaves this browser. */
function isImportedTrail(trailId: string): boolean {
  return trailId.startsWith('u_');
}

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/** "Synced 14:32" — the wall clock, because that is what a person checks against. */
function clockTime(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Backoff for a refusal the server might yet accept: 30 s, 2 min, 5 min, then
 * the edit waits for the next one (or for the tab to be looked at again).
 * Bounded on purpose — a page left open overnight must not keep knocking.
 */
const RETRY_DELAYS_MS = [30_000, 120_000, 300_000];

/**
 * How stale the last server read may be before a push takes one `GET` first.
 * This is the whole of the page's freshness policy: no poll, no interval — it
 * asks when it has a reason to, and otherwise stays quiet.
 */
const REFRESH_INTERVAL_MS = 5 * 60_000;

/** Newer of two ISO stamps, tolerating a document whose stamp is unparseable. */
function isNewer(a: string, b: string): boolean {
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (Number.isFinite(left) && Number.isFinite(right)) return left > right;
  return a > b;
}

export function initPlanSync(host: PlanSyncHost): PlanSyncController {
  const syncBtn = byId<HTMLButtonElement>('sync-btn');
  const statusEl = byId('sync-status');
  const shareBtn = byId<HTMLButtonElement>('share-btn');
  const sharePanel = byId('share-panel');
  const dialog = byId<HTMLDialogElement>('link-dialog');

  // No API in this build: the planner is the local-only page it always was.
  if (!getApiBase()) {
    for (const el of [syncBtn, statusEl, shareBtn, sharePanel, dialog]) el?.remove();
    return NO_OP;
  }

  if (!syncBtn || !statusEl) return NO_OP;

  // An imported trail says why it does not sync, and stops there.
  if (isImportedTrail(host.trailId)) {
    syncBtn.hidden = false;
    syncBtn.disabled = true;
    syncBtn.textContent = 'Imported trails stay on this device';
    syncBtn.title = 'A plan for a GPX you imported is never uploaded';
    shareBtn?.remove();
    sharePanel?.remove();
    dialog?.remove();
    return NO_OP;
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  let session: WebSession | null = loadSession();
  /** A `PUT` is in the air. */
  let inFlight = false;
  /** The whole push — the `PUT` and any follow-up — so `share()` can wait on it. */
  let currentPush: Promise<void> | null = null;
  /** An edit landed while one was in the air; push again when it returns. */
  let dirty = false;
  /** A `GET` is in the air. */
  let pulling = false;
  /**
   * The server stamp this page last saw — from the `PUT` that stored our copy,
   * or from the copy we adopted. It is what makes a conflict recognisable: a
   * server stamp that is not this one means somebody else wrote.
   */
  let syncedUpdatedAt: string | null = null;
  /** Edits made here that no `PUT` has confirmed yet. */
  let localEdits = false;
  /** When the server was last read, so an idle page can freshen before a push. */
  let lastPullAt: number | null = null;
  /** A conflict the reader should keep seeing after the sync settles. */
  let conflictNote: string | null = null;
  /** 409 `plan_exists` adopts the server's id once per push — never in a loop. */
  let adoptedExistingId = false;
  /** Backoff attempts spent on the refusal in hand; reset by a `PUT` that lands. */
  let retryAttempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  // -------------------------------------------------------------------------
  // Status line
  // -------------------------------------------------------------------------

  function setStatus(text: string, tone: 'plain' | 'warn' = 'plain'): void {
    if (!statusEl) return;
    statusEl.hidden = text === '';
    statusEl.textContent = text;
    statusEl.className = tone === 'warn' ? 'sync-warn' : '';
  }

  function setSynced(): void {
    // A conflict is not cleared by the sync that followed it: the reader is
    // told what happened to their edits until they make another one.
    const stamp = `Synced ${clockTime(new Date())}`;
    if (conflictNote) setStatus(`${conflictNote} \u00B7 ${stamp}`, 'warn');
    else setStatus(stamp);
  }

  /** The button reads who this browser is signed in as, once it is linked. */
  function renderChrome(): void {
    if (!syncBtn) return;
    syncBtn.hidden = false;
    syncBtn.disabled = false;
    if (session) {
      syncBtn.textContent = session.displayName;
      syncBtn.title = 'Linked browser — click to manage';
      if (shareBtn) shareBtn.hidden = false;
    } else {
      syncBtn.textContent = 'Sync';
      syncBtn.title = 'Link this browser to your phone to sync this plan';
      if (shareBtn) shareBtn.hidden = true;
      if (sharePanel) sharePanel.hidden = true;
      setStatus('');
    }
  }

  // -------------------------------------------------------------------------
  // The state machine
  // -------------------------------------------------------------------------

  /**
   * Read what the server holds for this trail and reconcile it with ours.
   *
   * Runs at boot, when the network comes back, when the tab is looked at
   * again, and before a push from a page that has been idle. One request each
   * time, and never on a timer: the plan on screen is only ever a few seconds
   * behind the phone when there is a reason for it to be.
   */
  async function pull(): Promise<void> {
    if (!session || destroyed) return;
    // A `PUT` in the air is about to report the server's stamp anyway, and a
    // second read alongside it would reconcile against a copy that is already
    // out of date by the time it lands.
    if (inFlight || pulling) return;
    pulling = true;
    setStatus('Syncing…');
    try {
      const { entry } = await fetchMyPlan(session, host.trailId);
      pulling = false;
      if (destroyed) return;
      lastPullAt = Date.now();
      if (entry && !isPlanDocument(entry.document)) {
        // Everything off the wire is data, not instructions: a document this
        // page cannot read is dropped whole rather than half-adopted, and the
        // local plan is left exactly as it was.
        setStatus('Sync failed: the server sent a plan this page cannot read', 'warn');
        return;
      }
      await reconcile(entry?.document ?? null);
    } catch (err) {
      pulling = false;
      handleFailure(err);
    }
  }

  /**
   * Decide between the server's copy and this page's.
   *
   * Two clocks are involved and neither can be trusted against the other:
   * `updatedAt` on the server's copy is the server's stamp, ours is this
   * browser's. Last writer by timestamp is still the rule — the phone and this
   * browser are nearly always the same person minutes apart, and anything
   * cleverer needs a history the document does not carry — but the losing side
   * is now said out loud rather than vanishing.
   *
   * The cases, in order:
   *
   *  - Nothing unsynced here, and we have spoken to the server before: its
   *    copy is simply the truth, whatever the clocks say. A browser clock an
   *    hour fast must not pin a stale copy over the phone's newer one.
   *  - Unsynced edits here AND a server stamp we have never seen: a real
   *    conflict. Timestamps still decide it; `conflictNote` says which way.
   *  - Otherwise (the boot read, before any server stamp is known — the local
   *    copy may well hold edits made offline in an earlier session): last
   *    writer by timestamp, quietly.
   */
  async function reconcile(serverDoc: PlanDocument | null): Promise<void> {
    if (!serverDoc) {
      // The server holds no plan for this trail, so ours is the only copy.
      await push();
      return;
    }
    // The feed's cursor is inclusive, so a pull can hand back the very row we
    // last stored. An equal stamp is therefore not news, it is the same copy:
    // nothing is adopted and nothing is sent.
    const serverIsNew = serverDoc.updatedAt !== syncedUpdatedAt;

    if (!localEdits) {
      if (syncedUpdatedAt !== null) {
        if (serverIsNew) adopt(serverDoc);
        else setSynced();
        return;
      }
    } else if (syncedUpdatedAt !== null && serverIsNew) {
      if (isNewer(serverDoc.updatedAt, host.getPlan().updatedAt)) {
        conflictNote = 'Replaced by the copy from your phone';
        adopt(serverDoc);
      } else {
        conflictNote = 'Kept your edits';
        await push();
      }
      return;
    }

    if (isNewer(serverDoc.updatedAt, host.getPlan().updatedAt)) {
      adopt(serverDoc);
      return;
    }
    await push();
  }

  /** Take the server's copy, and stop trying to send the one it replaced. */
  function adopt(serverDoc: PlanDocument): void {
    syncedUpdatedAt = serverDoc.updatedAt;
    localEdits = false;
    dirty = false;
    retryAttempt = 0;
    clearRetry();
    host.adoptServerPlan(serverDoc);
    setSynced();
  }

  /**
   * Send the document, unless the server already has this exact version or a
   * `PUT` is still in the air (in which case one more goes out when it lands —
   * a burst of toggles is one request, not one per toggle, and the debounce in
   * the viewer has already collapsed most of it).
   *
   * Returns a promise that settles when the whole push has, follow-ups
   * included, so `share()` can wait for the plan to be on the server before it
   * asks for a link to it.
   */
  function push(): Promise<void> {
    if (!session || destroyed) return Promise.resolve();
    if (currentPush) {
      dirty = true;
      return currentPush;
    }
    clearRetry();
    const running = pushLoop().finally(() => {
      if (currentPush === running) currentPush = null;
    });
    currentPush = running;
    return running;
  }

  /**
   * One `PUT`, then another if the document moved on under it or the server
   * handed us its own id. A loop rather than recursion, so the promise
   * `push()` returns covers every request the edit causes.
   */
  async function pushLoop(): Promise<void> {
    for (;;) {
      if (!session || destroyed) return;
      const sent = host.getPlan();
      if (syncedUpdatedAt !== null && sent.updatedAt === syncedUpdatedAt) {
        setSynced();
        return;
      }

      inFlight = true;
      setStatus('Syncing…');
      try {
        const entry = await putPlan(session, sent);
        inFlight = false;
        if (destroyed) return;
        adoptedExistingId = false;
        retryAttempt = 0;
        // Only stamp the server's clock on when nothing was edited under us;
        // otherwise the newer local document keeps its own stamp and the
        // follow-up below sends it.
        if (host.getPlan().updatedAt === sent.updatedAt) {
          syncedUpdatedAt = entry.updatedAt;
          localEdits = false;
          host.stampPlan({ updatedAt: entry.updatedAt });
        }
        setSynced();
        if (!dirty) return;
        dirty = false;
      } catch (err) {
        inFlight = false;
        if (destroyed) return;
        // The server already holds a plan for this trail under another id, and
        // has just said which: send the same document again under that id.
        if (adoptExistingId(err)) continue;
        handlePushFailure(err);
        return;
      }
    }
  }

  /**
   * 409 `plan_exists`: this browser's document is the same plan by a different
   * name, so it takes the id the server named rather than becoming a second
   * plan. True when the id was taken and the document should go again.
   */
  function adoptExistingId(err: unknown): boolean {
    if (adoptedExistingId) return false;
    if (!(err instanceof ApiError) || err.status !== 409 || err.code !== 'plan_exists') return false;
    const existingId = (err.body as { existingId?: unknown } | undefined)?.existingId;
    if (typeof existingId !== 'string') return false;
    adoptedExistingId = true;
    host.stampPlan({ id: existingId });
    return true;
  }

  /** A failure with no document in flight (a read). */
  function handleFailure(err: unknown): void {
    if (destroyed) return;
    if (err instanceof NetworkError) {
      // `onOnline` re-reads the server and reconciles, so a boot read that
      // failed here never turns into a blind `PUT` of a stale document.
      setStatus('Offline, will retry', 'warn');
      return;
    }
    if (err instanceof ApiError && err.status === 401) {
      onUnauthorised();
      return;
    }
    if (err instanceof ApiError && err.code === 'primary_token_required') {
      // Something only the phone's own token may do. Nothing on this page asks
      // for it, but a code the reader cannot act on is no answer if one ever
      // does — say where the button is instead.
      setStatus('Only your phone can do that — open Tracknotes there', 'warn');
      return;
    }
    if (err instanceof ApiError) {
      setStatus(`Sync failed: ${err.code}`, 'warn');
      return;
    }
    setStatus('Sync failed', 'warn');
  }

  /**
   * True for a refusal that is about this moment rather than this document:
   * too many requests, or a server having a bad minute.
   *
   * Everything else is permanent and retrying it would be noise — a 400
   * (`duplicate_stop_km`, `duplicate_stop_waypoint`) will be refused the same
   * way for ever, and a 403 `banned` account will not be unbanned by asking
   * again. Those show their code and stop.
   */
  function isRetriable(err: unknown): err is ApiError {
    return err instanceof ApiError && (err.status === 429 || err.status >= 500);
  }

  function handlePushFailure(err: unknown): void {
    if (destroyed) return;
    // Whatever went wrong, the next 409 may adopt again: leaving the flag set
    // for the life of the page would strand the plan under an id the server
    // refuses.
    adoptedExistingId = false;
    if (isRetriable(err)) {
      // Too many requests, or the server having a bad minute. The edit is
      // saved locally either way; this is only about when it goes up.
      setStatus(`Sync failed: ${err.code}`, 'warn');
      scheduleRetry();
      return;
    }
    handleFailure(err);
  }

  function clearRetry(): void {
    if (retryTimer === null) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  /** Book the next backoff attempt, if there is one left. */
  function scheduleRetry(): void {
    if (retryAttempt >= RETRY_DELAYS_MS.length) return;
    const delay = RETRY_DELAYS_MS[retryAttempt];
    retryAttempt += 1;
    clearRetry();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void push();
    }, delay);
  }

  /** True when the last good read is old enough to be worth refreshing. */
  function readIsStale(): boolean {
    return lastPullAt !== null && Date.now() - lastPullAt > REFRESH_INTERVAL_MS;
  }

  /** The token is gone (revoked from the phone, or expired). */
  function onUnauthorised(): void {
    clearSession();
    clearRetry();
    session = null;
    syncedUpdatedAt = null;
    renderChrome();
    setStatus('Browser unlinked — link again', 'warn');
  }

  // -------------------------------------------------------------------------
  // The link dialog
  // -------------------------------------------------------------------------

  const codeInput = byId<HTMLInputElement>('link-code');
  const labelInput = byId<HTMLInputElement>('link-label');
  const errorEl = byId('link-error');
  const unlinkedPane = byId('link-unlinked');
  const linkedPane = byId('link-linked');
  const displayNameEl = byId('link-display-name');
  const submitBtn = byId<HTMLButtonElement>('link-submit');

  function setLinkError(message: string): void {
    if (!errorEl) return;
    errorEl.hidden = message === '';
    errorEl.textContent = message;
  }

  function openDialog(): void {
    if (!dialog) return;
    setLinkError('');
    const linked = session !== null;
    if (unlinkedPane) unlinkedPane.hidden = linked;
    if (linkedPane) linkedPane.hidden = !linked;
    if (submitBtn) submitBtn.hidden = linked;
    if (displayNameEl) displayNameEl.textContent = session?.displayName ?? '';
    if (!linked && labelInput && labelInput.value.trim() === '') {
      labelInput.value = thisBrowserLabel();
    }
    // jsdom (and a browser without <dialog>) has no showModal; the `open`
    // attribute shows the element in place, which is all a test needs.
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    if (!linked) codeInput?.focus();
  }

  function closeDialog(): void {
    if (!dialog) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  async function submitCode(): Promise<void> {
    if (!codeInput) return;
    const code = normaliseLinkCode(codeInput.value);
    codeInput.value = code;
    if (code.length !== LINK_CODE_LENGTH) {
      setLinkError(`Enter the ${LINK_CODE_LENGTH}-character code from your phone.`);
      return;
    }
    setLinkError('');
    if (submitBtn) submitBtn.disabled = true;
    try {
      session = await linkDevice(code, labelInput?.value ?? thisBrowserLabel());
      closeDialog();
      renderChrome();
      // A freshly linked browser has a local plan the account has never seen,
      // so this is where it first goes up.
      await pull();
    } catch (err) {
      if (err instanceof NetworkError) {
        setLinkError('Could not reach the server. Check your connection and try again.');
      } else if (err instanceof ApiError && err.code === 'code_invalid') {
        setLinkError('That code is not valid or has expired. Ask your phone for a new one.');
      } else if (err instanceof ApiError && err.code === 'primary_token_required') {
        setLinkError('Only your phone can do that. Open Tracknotes on your phone and try there.');
      } else if (err instanceof ApiError && err.code === 'rate_limited') {
        setLinkError('Too many attempts. Wait a few minutes and try again.');
      } else if (err instanceof ApiError) {
        setLinkError(`Could not link this browser (${err.code}).`);
      } else {
        setLinkError('Could not link this browser.');
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  async function unlink(): Promise<void> {
    if (!session) return;
    const current = session;
    session = null;
    syncedUpdatedAt = null;
    closeDialog();
    renderChrome();
    setStatus('');
    await unlinkThisBrowser(current);
  }

  // -------------------------------------------------------------------------
  // Sharing
  // -------------------------------------------------------------------------

  const shareUrlInput = byId<HTMLInputElement>('share-url');
  const shareCopyBtn = byId<HTMLButtonElement>('share-copy');
  const shareNote = byId('share-note');

  function setShareNote(text: string): void {
    if (!shareNote) return;
    shareNote.hidden = text === '';
    shareNote.textContent = text;
  }

  async function share(): Promise<void> {
    if (!session || !sharePanel) return;
    setShareNote('');
    try {
      // A plan the server has never seen cannot be shared, so the document
      // goes up first. `push()` settles only when the `PUT` in the air (and
      // any follow-up it causes) has landed — sharing a plan the server has
      // not stored yet would mint a link to the version before this edit.
      await push();
      const { url } = await sharePlan(session, host.getPlan().id);
      if (shareUrlInput) shareUrlInput.value = url;
      sharePanel.hidden = false;
    } catch (err) {
      sharePanel.hidden = false;
      if (shareUrlInput) shareUrlInput.value = '';
      setShareNote(
        err instanceof ApiError ? `Could not share: ${err.code}` : 'Could not reach the server.',
      );
    }
  }

  async function copyShareUrl(): Promise<void> {
    const url = shareUrlInput?.value ?? '';
    if (!url) return;
    const clipboard = navigator.clipboard;
    if (clipboard && typeof clipboard.writeText === 'function') {
      try {
        await clipboard.writeText(url);
        setShareNote('Link copied.');
        return;
      } catch {
        // Permission refused, or an insecure origin — fall through.
      }
    }
    shareUrlInput?.select();
    setShareNote('Press ⌘C / Ctrl-C to copy.');
  }

  async function stopSharing(): Promise<void> {
    if (!session) return;
    try {
      await unsharePlan(session, host.getPlan().id);
      if (shareUrlInput) shareUrlInput.value = '';
      if (sharePanel) sharePanel.hidden = true;
      setShareNote('');
    } catch (err) {
      setShareNote(
        err instanceof ApiError ? `Could not unshare: ${err.code}` : 'Could not reach the server.',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  /**
   * The network is back. Re-read before writing: whatever failed may have been
   * the boot read, and pushing on its own would send a document this page has
   * never compared against the server's — straight over whatever the phone
   * synced in the meantime. `pull()` ends in a push when ours is the copy to
   * keep, so nothing is lost either way.
   */
  const onOnline = (): void => {
    if (!session || destroyed) return;
    void pull();
  };

  /** Coming back to the tab is the other moment a stale plan is worth a read. */
  const onVisibilityChange = (): void => {
    if (!session || destroyed) return;
    if (document.visibilityState !== 'visible') return;
    void pull();
  };

  syncBtn.addEventListener('click', openDialog);
  byId('link-cancel')?.addEventListener('click', closeDialog);
  byId('link-unlink')?.addEventListener('click', () => void unlink());
  byId<HTMLFormElement>('link-form')?.addEventListener('submit', event => {
    event.preventDefault();
    void submitCode();
  });
  submitBtn?.addEventListener('click', event => {
    // The button is a submit, but a dialog in a browser without form
    // submission (and jsdom) needs the direct path too.
    event.preventDefault();
    void submitCode();
  });
  codeInput?.addEventListener('input', () => {
    if (codeInput.value !== codeInput.value.toUpperCase()) {
      codeInput.value = codeInput.value.toUpperCase();
    }
  });
  shareBtn?.addEventListener('click', () => void share());
  shareCopyBtn?.addEventListener('click', () => void copyShareUrl());
  byId('share-unshare')?.addEventListener('click', () => void stopSharing());
  byId('share-close')?.addEventListener('click', () => {
    if (sharePanel) sharePanel.hidden = true;
  });
  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisibilityChange);

  renderChrome();
  // Boot: ask the server what it holds for this trail, and reconcile.
  if (session) void pull();

  return {
    onLocalSave(): void {
      if (!session || destroyed) return;
      localEdits = true;
      // The reader has moved on; whatever the last conflict was, it is no
      // longer what the status line should be saying.
      conflictNote = null;
      // A page that has sat idle asks what the server holds before writing
      // over it — one `GET`, at most every REFRESH_INTERVAL_MS, and the
      // reconciliation that follows pushes this edit when it is the newer one.
      // Only when nothing is already in the air, though: `pull()` declines to
      // run alongside a request, and this edit would go nowhere.
      if (currentPush === null && !pulling && readIsStale()) void pull();
      else void push();
    },
    destroy(): void {
      destroyed = true;
      clearRetry();
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    },
  };
}
