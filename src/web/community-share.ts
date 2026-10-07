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
 * trail that will be sent, so the hiker sees a failure before uploading. The
 * worker runs them again on what arrives, and its answer is the one that
 * counts: a 422 shows the server's list in place of ours.
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

  const runChecks = (): void => {
    if (!source) return;
    const meta = { name: nameInput.value.trim(), description: descInput.value.trim() };
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

  const renderIdentity = (): void => {
    session = loadSession();
    if (!session) {
      form.hidden = true;
      linkBox.hidden = false;
      renderLinkForm(
        linkBox,
        'Sharing a route needs your Tracknotes app identity, so that you can edit or delete it later and so that abuse can be dealt with. Link this browser to the app on your phone to continue.',
        () => renderIdentity(),
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
    switch (err.status) {
      case 409:
        return 'This route has already been shared — the same track was shared before.';
      case 413:
        return 'This route is too large to share.';
      case 422:
        return 'The server’s checks did not pass. See the list above.';
      case 429:
        return `You can share up to ${COMMUNITY_LIMITS.submitsPerDay} routes a day. Try again tomorrow.`;
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
    const current = loadSession();
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
    if (source.gpxText && utf8Bytes(source.gpxText) <= COMMUNITY_LIMITS.gpxMaxBytes) {
      request.gpxBase64 = utf8ToBase64(source.gpxText);
    }

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
  form.addEventListener('submit', event => {
    event.preventDefault();
    void submit();
  });
  unlinkBtn.addEventListener('click', () => {
    const current = loadSession();
    unlinkBtn.disabled = true;
    void (current ? unlinkThisBrowser(current) : Promise.resolve()).finally(() => {
      unlinkBtn.disabled = false;
      renderIdentity();
    });
  });

  return {
    open(next) {
      source = next;
      nameInput.value = next.name.slice(0, COMMUNITY_LIMITS.nameMax);
      done.hidden = true;
      setError('');
      updateCounter();
      renderIdentity();
      runChecks();
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
