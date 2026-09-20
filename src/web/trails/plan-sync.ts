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
 * Nothing in here runs at all unless `VITE_API_BASE_URL` was set at build
 * time; without it the buttons are removed and the planner is exactly the
 * local-only page it was before. Imported (`u_`) trails keep their plans on
 * this device, as their comments do, so they get the button with the reason
 * on it and no machinery behind it.
 */

import type { PlanDocument } from '@lib/plan-types';
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
  /** An edit landed while one was in the air; push again when it returns. */
  let dirty = false;
  /** The document `updatedAt` the server has confirmed; null until it has. */
  let syncedUpdatedAt: string | null = null;
  /** A `NetworkError` is waiting on `online` (or on the next edit). */
  let retryWhenOnline = false;
  /** 409 `plan_exists` adopts the server's id once — never in a loop. */
  let adoptedExistingId = false;
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
    setStatus(`Synced ${clockTime(new Date())}`);
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
   * Boot: ask the server what it holds for this trail. A copy newer than the
   * local one replaces it (last writer wins, as for comments); otherwise the
   * local one is pushed, which also covers "the server has none".
   */
  async function initialSync(): Promise<void> {
    if (!session || destroyed) return;
    setStatus('Syncing…');
    try {
      const { entry } = await fetchMyPlan(session, host.trailId);
      if (destroyed) return;
      if (entry && isNewer(entry.document.updatedAt, host.getPlan().updatedAt)) {
        syncedUpdatedAt = entry.document.updatedAt;
        host.adoptServerPlan(entry.document);
        setSynced();
        return;
      }
      await push();
    } catch (err) {
      handleFailure(err);
    }
  }

  /**
   * Send the document, unless the server already has this exact version or a
   * `PUT` is still in the air (in which case one more goes out when it lands —
   * a burst of toggles is one request, not one per toggle, and the debounce in
   * the viewer has already collapsed most of it).
   */
  async function push(): Promise<void> {
    if (!session || destroyed) return;
    if (inFlight) {
      dirty = true;
      return;
    }
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
      adoptedExistingId = false;
      if (destroyed) return;
      // Only stamp the server's clock on when nothing was edited under us;
      // otherwise the newer local document keeps its own stamp and the
      // follow-up push below sends it.
      if (host.getPlan().updatedAt === sent.updatedAt) {
        syncedUpdatedAt = entry.updatedAt;
        host.stampPlan({ updatedAt: entry.updatedAt });
      }
      setSynced();
      if (dirty) {
        dirty = false;
        await push();
      }
    } catch (err) {
      inFlight = false;
      await handlePushFailure(err);
    }
  }

  /** A failure with no document in flight (the boot read). */
  function handleFailure(err: unknown): void {
    if (destroyed) return;
    if (err instanceof NetworkError) {
      retryWhenOnline = true;
      setStatus('Offline, will retry', 'warn');
      return;
    }
    if (err instanceof ApiError && err.status === 401) {
      onUnauthorised();
      return;
    }
    if (err instanceof ApiError) {
      setStatus(`Sync failed: ${err.code}`, 'warn');
      return;
    }
    setStatus('Sync failed', 'warn');
  }

  async function handlePushFailure(err: unknown): Promise<void> {
    if (destroyed) return;
    if (
      err instanceof ApiError &&
      err.status === 409 &&
      err.code === 'plan_exists' &&
      !adoptedExistingId
    ) {
      const existingId = (err.body as { existingId?: unknown } | undefined)?.existingId;
      if (typeof existingId === 'string') {
        // The server already holds a plan for this trail under another id —
        // this browser's document is the same plan by a different name, so it
        // takes that id and replaces it rather than becoming a second plan.
        adoptedExistingId = true;
        host.stampPlan({ id: existingId });
        await push();
        return;
      }
    }
    handleFailure(err);
  }

  /** The token is gone (revoked from the phone, or expired). */
  function onUnauthorised(): void {
    clearSession();
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
      await initialSync();
    } catch (err) {
      if (err instanceof NetworkError) {
        setLinkError('Could not reach the server. Check your connection and try again.');
      } else if (err instanceof ApiError && err.code === 'code_invalid') {
        setLinkError('That code is not valid or has expired. Ask your phone for a new one.');
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
      // A plan the server has never seen cannot be shared; the push is the
      // same one every edit makes, so this costs nothing when it is up to date.
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

  const onOnline = (): void => {
    if (!retryWhenOnline || !session) return;
    retryWhenOnline = false;
    void push();
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

  renderChrome();
  if (session) void initialSync();

  return {
    onLocalSave(): void {
      if (!session || destroyed) return;
      retryWhenOnline = false;
      void push();
    },
    destroy(): void {
      destroyed = true;
      window.removeEventListener('online', onOnline);
    },
  };
}
