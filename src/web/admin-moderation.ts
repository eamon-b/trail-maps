/**
 * Boot script for `admin-moderation.html` — reported comments and shared hiker
 * waypoints, with each report's reason and detail, and the actions an admin
 * takes on them: delete (final), restore a hide, ban or unban the author.
 *
 * Needs a linked browser whose account the worker treats as an admin; a 403
 * says so. The server decides who is an admin and re-checks every action —
 * this page only renders what `GET /v1/admin/comments?reported=1` and
 * `GET /v1/admin/waypoints` return. Modelled on `admin-community.ts`.
 */

import type { AdminComment, AdminCommentReport, AdminSharedWaypoint, ContentReview } from '@lib/comments-api-types';
import { safeHttpUrl } from '@lib/poi-display';
import { ApiError, NetworkError, getApiBase } from './api/client';
import {
  adminDeleteComment,
  adminDeleteSharedWaypoint,
  adminListReportedComments,
  adminListSharedWaypoints,
  adminRestoreComment,
  adminRestoreSharedWaypoint,
  adminSetBanned,
} from './api/moderation';
import { clearSession, loadSession, type WebSession } from './api/session';
import { renderLinkForm } from './link-browser';
import { escapeHtml } from './web-utils';

function $(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`admin-moderation.html is missing #${id}`);
  return node;
}

type DeletedBy = AdminComment['deletedBy'];

/** Where a comment or waypoint stands, in words. */
export function stateLabel(
  deletedBy: DeletedBy,
  deletedAt: string | null,
  review: ContentReview | null = null
): string {
  if (deletedAt === null) return 'Live';
  switch (deletedBy) {
    case 'reports':
      return review?.hid ? 'Hidden by the automated review' : 'Hidden by reports';
    case 'admin':
      return 'Deleted by an admin';
    case 'owner':
      return 'Deleted by its author';
    default:
      return 'Deleted';
  }
}

function reportsHtml(reports: readonly AdminCommentReport[]): string {
  if (reports.length === 0) return '';
  return `<ul>${reports
    .map(
      r =>
        `<li><strong>${escapeHtml(r.reason)}</strong>${r.detail ? `: ${escapeHtml(r.detail)}` : ''} <span class="community-hint">— ${escapeHtml(
          r.reporterDisplayName
        )} · ${escapeHtml(r.createdAt)}</span></li>`
    )
    .join('')}</ul>`;
}

/**
 * The automated review (worker `content-review.ts`), for the admin's eyes: what
 * asked for it, the verdict and why. Empty when none was asked for.
 */
export function reviewHtml(review: ContentReview | null): string {
  if (!review) return '';
  const trigger =
    review.trigger === 'screen'
      ? `flagged by the screen${review.screenCategories?.length ? ` (${review.screenCategories.join(', ')})` : ''}`
      : 'after a report';
  let body: string;
  if (review.status === 'pending') body = 'Pending';
  else if (review.status === 'failed') body = `Failed (${escapeHtml(review.error ?? 'unknown')}) — reporters decide`;
  else {
    const confidence = review.confidence === undefined ? '' : ` · ${Math.round(review.confidence * 100)}%`;
    const categories = review.categories?.length ? ` · ${review.categories.join(', ')}` : '';
    body = `<strong>${escapeHtml(review.verdict ?? '')}</strong>${escapeHtml(confidence)}${escapeHtml(categories)}${
      review.summary ? `: ${escapeHtml(review.summary)}` : ''
    }`;
  }
  return `<dt>Review</dt><dd>${body} <span class="community-hint">— ${escapeHtml(trigger)}${
    review.reviewedAt ? ` · ${escapeHtml(review.reviewedAt)}` : ''
  }</span></dd>`;
}

/** Hidden provisionally, or the review wants a human: the row needs an admin. */
function needsAttention(row: { deletedBy: DeletedBy; review: ContentReview | null }): boolean {
  return (
    row.deletedBy === 'reports' ||
    (row.deletedBy === null && row.review?.verdict !== undefined && row.review.verdict !== 'keep')
  );
}

function button(
  kind: string,
  id: string,
  action: string,
  label: string,
  enabled: boolean,
  cls = '',
  userId = ''
): string {
  return `<button type="button" class="community-btn ${cls}" data-kind="${kind}" data-action="${action}" data-id="${escapeHtml(
    id
  )}"${userId ? ` data-user="${escapeHtml(userId)}"` : ''}${enabled ? '' : ' disabled'}>${label}</button>`;
}

/** Who posted it, as far as the ban controls go. */
interface Author {
  userId: string;
  userBanned: boolean;
  userAdmin: boolean;
  userDeleted: boolean;
}

/**
 * The ban controls for an author: ban, ban and remove everything, or unban.
 * None for an admin (who cannot be banned) or a deleted account (which can
 * never be unbanned, and whose posts are already gone).
 */
function banButtons(kind: string, id: string, author: Author): string {
  const { userId } = author;
  if (author.userDeleted) return '<span class="community-hint">Account deleted</span>';
  if (author.userAdmin) return '<span class="community-hint">Posted by an admin</span>';
  return author.userBanned
    ? button(kind, id, 'unban', 'Unban author', true, '', userId)
    : `${button(kind, id, 'ban', 'Ban author', true, 'is-danger', userId)}${button(
        kind,
        id,
        'ban-remove',
        'Ban and remove all their posts',
        true,
        'is-danger',
        userId
      )}`;
}

export function commentRowHtml(comment: AdminComment): string {
  const id = comment.id;
  const hidden = comment.deletedAt !== null;
  const photos = comment.photoUrls
    .map(u => safeHttpUrl(u))
    .filter((u): u is string => u !== undefined)
    .map((u, i) => `<a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">Photo ${i + 1}</a>`)
    .join(' · ');
  return `
    <article class="admin-row${needsAttention(comment) ? ' admin-row-attention' : ''}" data-row="${escapeHtml(id)}">
      <h3>${escapeHtml(comment.displayName)} · ${escapeHtml(stateLabel(comment.deletedBy, comment.deletedAt, comment.review))}${
        comment.userBanned && !comment.userDeleted ? ' · <span class="community-hint">author banned</span>' : ''
      }</h3>
      <p class="community-description">${comment.text ? escapeHtml(comment.text).replace(/\r?\n/g, '<br>') : '<em>(no text)</em>'}</p>
      <dl>
        <dt>Id</dt><dd><code>${escapeHtml(id)}</code></dd>
        <dt>Place</dt><dd><code>${escapeHtml(comment.trailId)}</code> / <code>${escapeHtml(comment.waypointId)}</code></dd>
        ${comment.waterStatus ? `<dt>Water</dt><dd>${escapeHtml(comment.waterStatus)}</dd>` : ''}
        ${photos ? `<dt>Photos</dt><dd>${photos}</dd>` : ''}
        <dt>Posted</dt><dd>${escapeHtml(comment.createdAt)} · author <code>${escapeHtml(comment.userId)}</code></dd>
        ${comment.restoredAt ? `<dt>Restored</dt><dd>${escapeHtml(comment.restoredAt)}</dd>` : ''}
        <dt>Reports</dt><dd>${escapeHtml(comment.reportCount)}${reportsHtml(comment.reports)}</dd>
        ${reviewHtml(comment.review)}
      </dl>
      <div class="admin-row-actions">
        ${button('comment', id, 'restore', 'Restore', comment.deletedBy === 'reports', 'is-primary')}
        ${button('comment', id, 'delete', hidden ? 'Delete for good' : 'Delete', comment.deletedBy === null || comment.deletedBy === 'reports', 'is-danger')}
        ${banButtons('comment', id, comment)}
      </div>
      <p class="import-error" data-error="${escapeHtml(id)}" hidden></p>
    </article>`;
}

export function waypointRowHtml(waypoint: AdminSharedWaypoint): string {
  const id = waypoint.id;
  const hidden = waypoint.deletedAt !== null;
  return `
    <article class="admin-row${needsAttention(waypoint) ? ' admin-row-attention' : ''}" data-row="${escapeHtml(id)}">
      <h3>${escapeHtml(waypoint.name)} <span class="community-hint">(${escapeHtml(waypoint.type)})</span> · ${escapeHtml(
        stateLabel(waypoint.deletedBy, waypoint.deletedAt, waypoint.review)
      )}${waypoint.userBanned && !waypoint.userDeleted ? ' · <span class="community-hint">owner banned</span>' : ''}</h3>
      ${waypoint.description ? `<p class="community-description">${escapeHtml(waypoint.description).replace(/\r?\n/g, '<br>')}</p>` : ''}
      <dl>
        <dt>Id</dt><dd><code>${escapeHtml(id)}</code></dd>
        <dt>Trail</dt><dd><code>${escapeHtml(waypoint.trailId)}</code></dd>
        <dt>Position</dt><dd><a href="https://www.openstreetmap.org/?mlat=${escapeHtml(waypoint.lat)}&amp;mlon=${escapeHtml(
          waypoint.lon
        )}#map=16/${escapeHtml(waypoint.lat)}/${escapeHtml(waypoint.lon)}" target="_blank" rel="noopener noreferrer">${escapeHtml(
          waypoint.lat.toFixed(5)
        )}, ${escapeHtml(waypoint.lon.toFixed(5))}</a></dd>
        <dt>Shared</dt><dd>${escapeHtml(waypoint.displayName)} · ${escapeHtml(waypoint.createdAt)} · owner <code>${escapeHtml(
          waypoint.userId
        )}</code></dd>
        ${waypoint.restoredAt ? `<dt>Restored</dt><dd>${escapeHtml(waypoint.restoredAt)}</dd>` : ''}
        <dt>Reports</dt><dd>${escapeHtml(waypoint.reportCount)}${reportsHtml(waypoint.reports)}</dd>
        ${reviewHtml(waypoint.review)}
      </dl>
      <div class="admin-row-actions">
        ${button('waypoint', id, 'restore', 'Restore', waypoint.deletedBy === 'reports' || waypoint.deletedBy === 'admin', 'is-primary')}
        ${button('waypoint', id, 'delete', 'Delete', !hidden, 'is-danger')}
        ${banButtons('waypoint', id, waypoint)}
      </div>
      <p class="import-error" data-error="${escapeHtml(id)}" hidden></p>
    </article>`;
}

function init(): void {
  const status = $('admin-status');
  const linkBox = $('admin-link');
  const errorEl = $('admin-error');
  const toolbar = $('admin-toolbar');
  const commentsSection = $('admin-comments-section');
  const waypointsSection = $('admin-waypoints-section');
  const commentsList = $('admin-comments');
  const waypointsList = $('admin-waypoints');

  const setError = (message: string): void => {
    errorEl.textContent = message;
    errorEl.hidden = message === '';
  };

  if (!getApiBase()) {
    status.textContent = 'This build has no API configured (VITE_API_BASE_URL).';
    return;
  }

  let session: WebSession | null = null;

  const clearLists = (): void => {
    commentsSection.hidden = true;
    waypointsSection.hidden = true;
    commentsList.innerHTML = '';
    waypointsList.innerHTML = '';
  };

  const askToLink = (): void => {
    status.hidden = true;
    toolbar.hidden = true;
    clearLists();
    linkBox.hidden = false;
    renderLinkForm(
      linkBox,
      'Moderation needs an admin account. Link this browser to the Tracknotes app on that phone.',
      linked => {
        linkBox.hidden = true;
        linkBox.innerHTML = '';
        void load(linked);
      }
    );
  };

  /** (Re)load both lists; see `admin-community.ts` for why a fresh link is passed in. */
  const load = async (linked?: WebSession): Promise<void> => {
    session = linked ?? session ?? loadSession();
    setError('');
    if (!session) {
      askToLink();
      return;
    }
    status.hidden = false;
    status.textContent = 'Loading…';
    let comments: AdminComment[];
    let waypoints: AdminSharedWaypoint[];
    try {
      [comments, waypoints] = await Promise.all([
        adminListReportedComments(session),
        adminListSharedWaypoints(session),
      ]);
    } catch (err) {
      status.hidden = true;
      clearLists();
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        session = null;
        askToLink();
      } else if (err instanceof ApiError && err.status === 403) {
        setError('This account is not an admin.');
        toolbar.hidden = false;
        $('admin-identity').textContent = `Linked as ${session.displayName || 'this account'}.`;
      } else if (err instanceof NetworkError) {
        setError('Could not reach the server. Check your connection and reload.');
      } else {
        setError(`Could not load: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    status.hidden = true;
    toolbar.hidden = false;
    const hiddenCount =
      comments.filter(c => c.deletedBy === 'reports').length + waypoints.filter(w => w.deletedBy === 'reports').length;
    $('admin-identity').textContent =
      `Linked as ${session.displayName || 'this account'} · ${comments.length} reported or flagged comment${
        comments.length === 1 ? '' : 's'
      } · ${waypoints.length} shared waypoint${waypoints.length === 1 ? '' : 's'} · ${hiddenCount} hidden by reports or the review`;
    commentsSection.hidden = false;
    waypointsSection.hidden = false;
    commentsList.innerHTML =
      comments.length > 0 ? comments.map(commentRowHtml).join('') : '<p class="import-note">No reported comments.</p>';
    waypointsList.innerHTML =
      waypoints.length > 0
        ? waypoints.map(waypointRowHtml).join('')
        : '<p class="import-note">No shared waypoints.</p>';
  };

  const onClick =
    (list: HTMLElement) =>
    (event: Event): void => {
      const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
      if (!target || !session) return;
      const id = target.dataset.id!;
      const action = target.dataset.action!;
      const kind = target.dataset.kind!;
      const userId = target.dataset.user ?? '';
      const rowError = list.querySelector<HTMLElement>(`[data-error="${CSS.escape(id)}"]`);
      const current = session;
      const noun = kind === 'comment' ? 'comment' : 'waypoint';

      if (action === 'delete' && !window.confirm(`Delete this ${noun}? This cannot be undone.`)) return;
      if (action === 'ban' && !window.confirm('Ban this account? It will no longer be able to post.')) return;
      if (
        action === 'ban-remove' &&
        !window.confirm(
          'Ban this account and delete every comment and shared waypoint it has up? This cannot be undone.'
        )
      ) {
        return;
      }

      const run = async (): Promise<void> => {
        switch (action) {
          case 'restore':
            return kind === 'comment' ? adminRestoreComment(current, id) : adminRestoreSharedWaypoint(current, id);
          case 'delete':
            return kind === 'comment' ? adminDeleteComment(current, id) : adminDeleteSharedWaypoint(current, id);
          case 'ban':
            await adminSetBanned(current, userId, true);
            return;
          case 'ban-remove':
            await adminSetBanned(current, userId, true, true);
            return;
          case 'unban':
            await adminSetBanned(current, userId, false);
            return;
          default:
            return;
        }
      };

      const buttons = list.querySelectorAll<HTMLButtonElement>(`button[data-id="${CSS.escape(id)}"]`);
      for (const b of buttons) b.disabled = true;
      void run()
        .then(() => load())
        .catch((err: unknown) => {
          if (rowError) {
            rowError.textContent =
              err instanceof ApiError
                ? `Failed (${err.code}): ${err.message}`
                : `Failed: ${err instanceof Error ? err.message : String(err)}`;
            rowError.hidden = false;
          }
          for (const b of buttons) b.disabled = false;
        });
    };

  commentsList.addEventListener('click', onClick(commentsList));
  waypointsList.addEventListener('click', onClick(waypointsList));
  $('admin-reload').addEventListener('click', () => void load());
  void load();
}

init();
