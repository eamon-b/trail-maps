/**
 * The "Share with the community" step of upload.html. Spec:
 * `plans/community-routes.md`.
 *
 * Offered after an import has been saved, and only when the site was built
 * with an API (`VITE_API_BASE_URL`); `upload.ts` loads this module lazily so a
 * local-only build never pulls it in. Sharing needs the phone's identity, so
 * an unlinked browser is shown the same link-code form the planner uses
 * (through `api/session.ts`, which owns the token).
 *
 * The automatic checks (`@lib/community-checks`) run here live, on the very
 * trail that will be sent (and on the GPX text, when it is being sent), so the
 * hiker sees a failure before uploading. The worker runs them again on what
 * arrives, and its answer is the one that counts: a 422 shows the server's
 * list in place of ours.
 *
 * The raw GPX is optional ("Include the original GPX file", on by default):
 * a raw file can carry the author's name, device and recording times, so the
 * hiker may keep it back. A file over `COMMUNITY_LIMITS.gpxMaxBytes` is never
 * sent.
 */

import { runCommunityChecks } from '@lib/community-checks';
import {
  COMMUNITY_LIMITS,
  type CommunityCheck,
  type CommunitySubmitRequest,
} from '@lib/community-types';
import type { ProcessedTrail } from '@lib/trail-types';
import { ApiError, NetworkError } from './api/client';
import { checksFromError, communityRouteHref, submitCommunityRoute } from './api/community';
import { clearSession, loadSession, unlinkThisBrowser, type WebSession } from './api/session';
import {
  checksListHtml,
  initRegionPicker,
  utf8Bytes,
  utf8ToBase64,
  type RegionPicker,
} from './community-ui';
import { renderLinkForm } from './link-browser';

/** The worker's own wording from an error envelope, when it sent one. */
function serverErrorMessage(err: ApiError): string | null {
  const body = err.body as { error?: { message?: unknown } } | undefined;
  const message = body?.error?.message;
  return typeof message === 'string' && message.trim() !== '' ? message.trim() : null;
}

/** What the share step sends: the saved trail, its name and the source file. */
export interface CommunityShareSource {
  trail: ProcessedTrail;
  name: string;
  /** The GPX text as read, or null when it was not kept. */
  gpxText: string | null;
}

export interface CommunityShareController {
  /** Show the panel for a freshly saved import. */
  open(source: CommunityShareSource): void;
  /** Swap in a changed trail (e.g. elevation filled in) and re-run the checks. */
  refresh(trail?: ProcessedTrail): void;
  hide(): void;
}

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`upload.html is missing #${id}`);
  return node as T;
}

/** Wire the panel. Call once; `open()` it per saved import. */
export function initCommunityShare(): CommunityShareController {
  const panel = byId('community-share');
  const linkBox = byId('community-link');
  const form = byId<HTMLFormElement>('community-form');
  const identity = byId('community-identity');
  const nameInput = byId<HTMLInputElement>('community-name');
  const descInput = byId<HTMLTextAreaElement>('community-description');
  const descCount = byId('community-description-count');
  const creditInput = byId<HTMLInputElement>('community-credit');
  const countrySelect = byId<HTMLSelectElement>('community-country');
  const otherInput = byId<HTMLInputElement>('community-country-other');
  const otherWrapper = byId('community-country-other-field');
  const stateSelect = byId<HTMLSelectElement>('community-state');
  const stateWrapper = byId('community-state-field');
  const rightsBox = byId<HTMLInputElement>('community-rights');
  const includeGpxField = byId('community-include-gpx-field');
  const includeGpxBox = byId<HTMLInputElement>('community-include-gpx');
  const includeGpxNote = byId('community-include-gpx-note');
  const checksBox = byId('community-checks');
  const checksSource = byId('community-checks-source');
  const submitBtn = byId<HTMLButtonElement>('community-submit');
  const errorEl = byId('community-error');
  const done = byId('community-done');
  const doneLink = byId<HTMLAnchorElement>('community-done-link');
  const unlinkBtn = byId<HTMLButtonElement>('community-unlink');

  nameInput.maxLength = COMMUNITY_LIMITS.nameMax;
  descInput.maxLength = COMMUNITY_LIMITS.descriptionMax;
  creditInput.maxLength = COMMUNITY_LIMITS.creditMax;

  let source: CommunityShareSource | null = null;
  /** Whether `source.gpxText` fits under the upload cap (measured once per open). */
  let gpxFits = false;
  let session: WebSession | null = null;
  let localChecks: CommunityCheck[] = [];
  let checksOk = false;
  let busy = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const setError = (message: string): void => {
    errorEl.textContent = message;
    errorEl.hidden = message === '';
  };

  const updateSubmit = (): void => {
    const country = picker.country();
    submitBtn.disabled = busy || !source || !checksOk || !rightsBox.checked || country === null;
  };

  const picker: RegionPicker = initRegionPicker(
    countrySelect,
    otherInput,
    stateSelect,
    stateWrapper,
    otherWrapper,
    () => updateSubmit(),
  );

  const updateCounter = (): void => {
    const len = descInput.value.trim().length;
    const min = COMMUNITY_LIMITS.descriptionMin;
    descCount.textContent =
      len < min
        ? `${len} / ${COMMUNITY_LIMITS.descriptionMax} characters (at least ${min})`
        : `${len} / ${COMMUNITY_LIMITS.descriptionMax} characters`;
  };

  const showChecks = (checks: readonly CommunityCheck[], fromServer: boolean): void => {
    checksBox.innerHTML = checksListHtml(checks);
    checksSource.textContent = fromServer
      ? 'The server’s checks of what was uploaded:'
      : 'Automatic checks (run again by the server when you share):';
  };

  /** The GPX text that will go up with the route, or null when it will not. */
  const gpxToSend = (): string | null =>
    source?.gpxText && gpxFits && includeGpxBox.checked ? source.gpxText : null;

  const runChecks = (): void => {
    if (!source) return;
    // Only the GPX the server will also see: its checks are the ones that count.
    const gpxText = gpxToSend();
    const meta = {
      name: nameInput.value.trim(),
      description: descInput.value.trim(),
      ...(gpxText ? { gpxText } : {}),
    };
    try {
      const result = runCommunityChecks(source.trail, meta);
      localChecks = result.checks;
      checksOk = result.ok;
    } catch (err) {
      localChecks = [
        {
          id: 'shape',
          level: 'fail',
          message: `The checks could not run: ${err instanceof Error ? err.message : String(err)}`,
        },
      ];
      checksOk = false;
    }
    showChecks(localChecks, false);
    updateSubmit();
  };

  const scheduleChecks = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      runChecks();
    }, 250);
  };

  /**
   * Show the form for a linked browser, else the link form. `linked` is the
   * session the link form just produced: it is used as is rather than read
   * back from storage, which may be refusing writes.
   */
  const renderIdentity = (linked?: WebSession): void => {
    session = linked ?? loadSession();
    if (!session) {
      form.hidden = true;
      linkBox.hidden = false;
      renderLinkForm(
        linkBox,
        'Sharing a route needs your Tracknotes app identity, so that you can edit or delete it later and so that abuse can be dealt with. Link this browser to the app on your phone to continue.',
        next => renderIdentity(next),
      );
      return;
    }
    linkBox.hidden = true;
    linkBox.innerHTML = '';
    form.hidden = false;
    identity.textContent = `Sharing as ${session.displayName || 'your Tracknotes account'}.`;
  };

  const describeSubmitError = (err: unknown): string => {
    if (err instanceof NetworkError) return 'Could not reach the server. Check your connection and try again.';
    if (!(err instanceof ApiError)) return `Could not share this route: ${err instanceof Error ? err.message : String(err)}`;
    // The worker words these itself (the 30-attempt and 10-route daily limits
    // differ, for one); the fallbacks cover a reply without its envelope.
    const fromServer = serverErrorMessage(err);
    switch (err.status) {
      case 409:
        return fromServer ?? 'This route has already been shared — the same track was shared before.';
      case 413:
        return fromServer ?? 'This route is too large to share.';
      case 422:
        return 'The server’s checks did not pass. See the list above.';
      case 429:
        return fromServer ?? 'You have reached today’s limit for sharing routes. Try again tomorrow.';
      default:
        return `Could not share this route (${err.code}): ${err.message}`;
    }
  };

  const submit = async (): Promise<void> => {
    if (!source || busy) return;
    setError('');
    runChecks();
    const country = picker.country();
    if (!checksOk || !rightsBox.checked || !country) {
      updateSubmit();
      return;
    }
    const current = session;
    if (!current) {
      renderIdentity();
      return;
    }

    const request: CommunitySubmitRequest = {
      name: nameInput.value.trim(),
      description: descInput.value.trim(),
      credit: creditInput.value.trim() || null,
      country,
      state: picker.state(),
      rightsConfirmed: true,
      trail: source.trail,
    };
    if (utf8Bytes(JSON.stringify(source.trail)) > COMMUNITY_LIMITS.trailJsonMaxBytes) {
      setError('This route is too large to share (the processed trail is over 4 MB).');
      return;
    }
    const gpxText = gpxToSend();
    if (gpxText) request.gpxBase64 = utf8ToBase64(gpxText);

    busy = true;
    submitBtn.textContent = 'Sharing…';
    updateSubmit();
    try {
      const detail = await submitCommunityRoute(current, request);
      form.hidden = true;
      doneLink.href = `./${communityRouteHref(detail.id)}`;
      done.hidden = false;
      done.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        renderIdentity();
        setError('');
        return;
      }
      const serverChecks = checksFromError(err);
      if (serverChecks) showChecks(serverChecks, true);
      setError(describeSubmitError(err));
    } finally {
      busy = false;
      submitBtn.textContent = 'Share route';
      updateSubmit();
    }
  };

  nameInput.addEventListener('input', scheduleChecks);
  descInput.addEventListener('input', () => {
    updateCounter();
    scheduleChecks();
  });
  rightsBox.addEventListener('change', updateSubmit);
  includeGpxBox.addEventListener('change', runChecks);
  form.addEventListener('submit', event => {
    event.preventDefault();
    void submit();
  });
  unlinkBtn.addEventListener('click', () => {
    const current = session;
    session = null;
    unlinkBtn.disabled = true;
    void (current ? unlinkThisBrowser(current) : Promise.resolve()).finally(() => {
      unlinkBtn.disabled = false;
      renderIdentity();
    });
  });

  return {
    open(next) {
      // A fresh form per import: nothing typed for the previous route carries over.
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      source = next;
      nameInput.value = next.name.slice(0, COMMUNITY_LIMITS.nameMax);
      descInput.value = '';
      creditInput.value = '';
      rightsBox.checked = false;
      picker.set(null, null);
      checksBox.innerHTML = '';
      checksSource.textContent = '';
      localChecks = [];
      checksOk = false;

      gpxFits = next.gpxText !== null && utf8Bytes(next.gpxText) <= COMMUNITY_LIMITS.gpxMaxBytes;
      includeGpxField.hidden = next.gpxText === null;
      includeGpxBox.checked = gpxFits;
      includeGpxBox.disabled = !gpxFits;
      includeGpxNote.textContent = gpxFits
        ? ''
        : `The file is over ${Math.round(COMMUNITY_LIMITS.gpxMaxBytes / 1024 / 1024)} MB, so it is left out.`;
      includeGpxNote.hidden = gpxFits;

      done.hidden = true;
      setError('');
      updateCounter();
      renderIdentity();
      runChecks();
      updateSubmit();
      panel.hidden = false;
    },
    refresh(trail) {
      if (!source) return;
      if (trail) source = { ...source, trail };
      runChecks();
    },
    hide() {
      source = null;
      panel.hidden = true;
    },
  };
}
