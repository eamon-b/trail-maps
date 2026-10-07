/**
 * An inline "link this browser" form for the pages that need the phone's
 * identity outside the planner: sharing a route (upload.html), reporting or
 * editing one (community-route.html) and the admin queue.
 *
 * The planner has its own dialog (`trails/plan-sync.ts`); both go through the
 * same `linkDevice` in `api/session.ts`, so the token is stored and read in
 * exactly one place. This module only owns the markup and the error wording.
 */

import { ApiError, NetworkError } from './api/client';
import {
  LINK_CODE_LENGTH,
  linkDevice,
  normaliseLinkCode,
  thisBrowserLabel,
  type WebSession,
} from './api/session';

/** What to tell the reader when a link attempt fails. */
export function linkErrorMessage(err: unknown): string {
  if (err instanceof NetworkError) {
    return 'Could not reach the server. Check your connection and try again.';
  }
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'code_invalid':
        return 'That code is not valid or has expired. Ask your phone for a new one.';
      case 'primary_token_required':
        return 'Only your phone can do that. Open Tracknotes on your phone and try there.';
      case 'rate_limited':
        return 'Too many attempts. Wait a few minutes and try again.';
      default:
        return `Could not link this browser (${err.code}).`;
    }
  }
  return 'Could not link this browser.';
}

let formCounter = 0;

/**
 * Render the link form into `container` (replacing its content). `onLinked`
 * runs once the code has been exchanged and the session stored.
 *
 * @param intro  One sentence saying why linking is needed here (plain text).
 */
export function renderLinkForm(
  container: HTMLElement,
  intro: string,
  onLinked: (session: WebSession) => void,
): void {
  const n = ++formCounter;
  const codeId = `link-code-${n}`;
  const labelId = `link-label-${n}`;
  container.innerHTML = `
    <form class="community-link-form" novalidate>
      <p class="import-note community-link-intro"></p>
      <p class="import-note">
        On your phone open Tracknotes &rarr; Settings &rarr; Linked browsers &rarr;
        Link a browser, then enter the code here.
      </p>
      <div class="community-field">
        <label for="${codeId}">Code from your phone</label>
        <input type="text" id="${codeId}" class="community-input" maxlength="11"
          autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXXXXXX">
      </div>
      <div class="community-field">
        <label for="${labelId}">Name this browser</label>
        <input type="text" id="${labelId}" class="community-input" maxlength="60">
      </div>
      <p class="import-error" data-role="error" hidden></p>
      <button type="submit" class="process-btn">Link this browser</button>
    </form>`;

  const form = container.querySelector('form')!;
  (container.querySelector('.community-link-intro') as HTMLElement).textContent = intro;
  const codeInput = container.querySelector<HTMLInputElement>(`#${codeId}`)!;
  const labelInput = container.querySelector<HTMLInputElement>(`#${labelId}`)!;
  const errorEl = container.querySelector<HTMLElement>('[data-role="error"]')!;
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  labelInput.value = thisBrowserLabel();

  const setError = (message: string): void => {
    errorEl.textContent = message;
    errorEl.hidden = message === '';
  };

  form.addEventListener('submit', event => {
    event.preventDefault();
    const code = normaliseLinkCode(codeInput.value);
    codeInput.value = code;
    if (code.length !== LINK_CODE_LENGTH) {
      setError(`Enter the ${LINK_CODE_LENGTH}-character code from your phone.`);
      return;
    }
    setError('');
    submit.disabled = true;
    void linkDevice(code, labelInput.value || thisBrowserLabel())
      .then(session => onLinked(session))
      .catch((err: unknown) => setError(linkErrorMessage(err)))
      .finally(() => {
        submit.disabled = false;
      });
  });
}
