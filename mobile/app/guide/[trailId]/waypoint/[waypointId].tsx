/**
 * Waypoint detail screen.
 *
 * Resolves the tapped waypoint from the active guide, then layers on the
 * offline-first comments client: a newest-first feed (server rows + optimistic
 * local rows with "waiting to send" / "failed" affordances), the composer
 * (`features/comments/Composer` — water-flow chips, photo attach, and the
 * first-post display-name prompt), and a favorite heart backed by the local
 * favorites store.
 *
 * The feed reads straight from SQLite (so it renders instantly and offline);
 * mount kicks a background pull + drain and re-reads when they land. Since the
 * cache already holds every comment for the trail, paging is a widening LIMIT
 * over that cache rather than a network page fetch.
 *
 * Two other things ride the same sync channel: a "Report" affordance on other
 * people's synced rows (offline-first, via the outbox — an App Store UGC
 * requirement) and the curated waypoint description, which overrides the
 * near-empty bundled one.
 *
 * None of that channel exists for a user-imported guide (`services/server-trails`):
 * its ids are local-only, so the whole comments block collapses to a one-line
 * note and no SQLite read or request is issued for it. The favorite heart, the
 * stats and the check-in share are purely local and keep working.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Image } from 'expo-image';
import { formatDistance, formatElevation } from '@lib/format-distance';
import type { WaterStatus } from '@lib/comments-api-types';
import { useTheme } from '../../../../src/theme';
import { glyphSizes, radii, spacing, typography } from '../../../../src/tokens';
import { useSettingsStore } from '../../../../src/state/settings-store';
import { useGuide } from '../../../../src/features/guide/GuideContext';
import { useGuidePositionContext } from '../../../../src/features/guide/GuidePositionContext';
import { ShareIconButton } from '../../../../src/features/share/ShareIconButton';
import { useCheckInShare } from '../../../../src/features/share/use-check-in-share';
import { orderedWaypoints } from '../../../../src/features/guide/guide-trail';
import { waypointColor } from '../../../../src/features/elevation/waypoint-category';
import { formatSignedDistance } from '../../../../src/features/guide/waypoint-filters';
import {
  estimateEtaMinutes,
  formatEta,
  relativeDate,
  waterStatusMeta,
} from '../../../../src/features/guide/waypoint-detail';
import { useIdentityStore } from '../../../../src/state/identity-store';
import { selectIsFavorite, useFavoritesStore } from '../../../../src/state/favorites-store';
import { isServerKnown } from '../../../../src/services/server-trails';
import { getDatabase } from '../../../../src/db/database';
import * as commentsRepo from '../../../../src/db/comments-repo';
import type { CommentWithSyncState } from '../../../../src/db/comments-repo';
import * as waypointMetaRepo from '../../../../src/db/waypoint-meta-repo';
import { Composer } from '../../../../src/features/comments/Composer';
import { ReportDialog } from '../../../../src/features/comments/ReportDialog';
import { isApiConfigured } from '../../../../src/api/client';
import {
  deleteOwnComment,
  pullTrail,
  retryOutbox,
  submitComment,
  submitReport,
} from '../../../../src/sync/comment-sync';
import { onSyncChange } from '../../../../src/sync/sync-events';

/** Comments revealed per "show earlier" tap (and in the initial window). */
const COMMENT_PAGE_SIZE = 20;

export default function WaypointDetailScreen() {
  const { trailId, waypointId } = useLocalSearchParams<{
    trailId: string;
    waypointId: string;
  }>();
  const { colors } = useTheme();
  const { trail } = useGuide();
  const units = useSettingsStore((s) => s.units);
  const { currentKm, position, status } = useGuidePositionContext();
  const shareCheckIn = useCheckInShare();

  const waypoint = useMemo(() => {
    const list = orderedWaypoints(trail);
    return (
      list.find((w, i) => (w.id ?? `${w.name}-${i}`) === waypointId) ??
      list.find((w) => w.id === waypointId) ??
      null
    );
  }, [trail, waypointId]);

  // The comments channel needs BOTH a server-side trail (imported guides have
  // none) and a stable waypoint id. Null here switches the whole block off:
  // no SQLite read, no pull, no composer.
  const serverKnown = isServerKnown(trailId);
  const commentWaypointId = serverKnown ? (waypoint?.id ?? null) : null;

  const identityStatus = useIdentityStore((s) => s.status);
  const session = useIdentityStore((s) => s.session);
  const isFav = useFavoritesStore(selectIsFavorite(trailId, waypointId));
  const toggleFavorite = useFavoritesStore((s) => s.toggle);

  const [comments, setComments] = useState<CommentWithSyncState[] | null>(null);
  const [viewerUri, setViewerUri] = useState<string | null>(null);
  // Feed paging is over the LOCAL cache (trail sync pulls the whole set), so
  // "show earlier" just widens the query window — no network round trip.
  const [visibleCount, setVisibleCount] = useState(COMMENT_PAGE_SIZE);
  const [totalComments, setTotalComments] = useState(0);
  const [syncedDescription, setSyncedDescription] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [reportTarget, setReportTarget] = useState<CommentWithSyncState | null>(null);
  // Ephemeral per-session "Reported" acknowledgement; the report itself is
  // durable in the outbox and idempotent server-side, so nothing is persisted.
  const [reportedIds, setReportedIds] = useState<string[]>([]);

  const load = useCallback(async () => {
    if (!commentWaypointId) {
      setComments([]);
      setTotalComments(0);
      setSyncedDescription(null);
      return;
    }
    const db = await getDatabase();
    setComments(
      await commentsRepo.listByWaypoint(db, trailId, commentWaypointId, { limit: visibleCount }),
    );
    setTotalComments(await commentsRepo.countByWaypoint(db, trailId, commentWaypointId));
    setSyncedDescription(await waypointMetaRepo.getDescription(db, trailId, commentWaypointId));
  }, [trailId, commentWaypointId, visibleCount]);

  // Hydrate identity + favorites, load the cached feed, then pull in the
  // background and re-read.
  useEffect(() => {
    void useIdentityStore.getState().hydrate();
    void useFavoritesStore.getState().hydrate(trailId);
  }, [trailId]);

  // Read the cache on mount, whenever the paging window widens, and whenever a
  // background pull lands (`reloadToken`).
  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  // The background pull is keyed on the trail alone, so widening the paging
  // window re-queries SQLite without re-hitting the network.
  useEffect(() => {
    if (!serverKnown) return;
    let active = true;
    void (async () => {
      const res = await pullTrail(trailId);
      if (active && res.outcome === 'pulled') setReloadToken((t) => t + 1);
    })();
    return () => {
      active = false;
    };
  }, [serverKnown, trailId]);

  // A background drain/pull that changes rows (e.g. flips this comment
  // local→server) emits here; re-read so the mounted feed reflects it without
  // waiting for a refocus. Feeds are small, so re-query on any event for this
  // trail (or an unscoped one).
  useEffect(() => {
    return onSyncChange((change) => {
      if (change.trailId == null || change.trailId === trailId) void load();
    });
  }, [load, trailId]);

  if (!waypoint) {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: 'Waypoint' }} />
        <Text style={[styles.notFoundTitle, { color: colors.textPrimary }]}>
          Waypoint not found
        </Text>
      </View>
    );
  }

  const marker = waypointColor(waypoint.type, colors);
  const description = syncedDescription ?? waypoint.description;
  const remaining = Math.max(totalComments - (comments?.length ?? 0), 0);
  const km = waypoint.totalDistance ?? 0;
  const deltaKm = currentKm != null ? km - currentKm : null;
  const signed = deltaKm != null ? formatSignedDistance(deltaKm, units) : null;
  const etaLabel =
    deltaKm != null && deltaKm > 0 ? formatEta(estimateEtaMinutes(deltaKm)) : null;

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Stack.Screen options={{ title: waypoint.name }} />
      <ScrollView
        style={[styles.flex, { backgroundColor: colors.background }]}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* Hero header */}
        <View style={styles.hero}>
          <View style={styles.heroTop}>
            <View style={[styles.typeChip, { backgroundColor: marker }]}>
              <Text style={[styles.typeChipText, { color: colors.textInverse }]} numberOfLines={1}>
                {waypoint.type}
              </Text>
            </View>
            <View style={styles.heroActions}>
              <ShareIconButton
                color={colors.textSecondary}
                accessibilityLabel="Share check-in"
                onPress={() => {
                  const hasFix =
                    (status === 'fix' || status === 'off-trail') && position != null;
                  void shareCheckIn({
                    trailName: trail.config.name,
                    totalKm: trail.track.totalDistance,
                    units,
                    waypoint: {
                      name: waypoint.name,
                      km,
                      lat: waypoint.lat,
                      lon: waypoint.lon,
                    },
                    gps:
                      hasFix && position != null && currentKm != null
                        ? {
                            lat: position.lat,
                            lon: position.lon,
                            currentKm,
                            offTrail: status === 'off-trail',
                          }
                        : null,
                  });
                }}
              />
              <FavoriteHeart
                filled={isFav}
                onPress={() => void toggleFavorite(trailId, waypointId)}
              />
            </View>
          </View>
          <Text style={[styles.name, { color: colors.textPrimary }]}>{waypoint.name}</Text>
          {/* Curated descriptions arrive over the sync channel; the bundled
              trail JSON is the fallback. */}
          {description ? (
            <Text style={[styles.description, { color: colors.textSecondary }]}>
              {description}
            </Text>
          ) : null}
        </View>

        {/* Stats row */}
        <View style={styles.stats}>
          <Stat label="Distance" value={formatDistance(km, units)} />
          {waypoint.elevation != null && (
            <Stat label="Elevation" value={formatElevation(waypoint.elevation, units)} />
          )}
          {signed && signed.direction !== 'here' && (
            <Stat
              label={signed.direction === 'ahead' ? 'Ahead' : 'Behind'}
              value={etaLabel ? `${signed.label.replace(/ (ahead|behind)$/, '')} · ${etaLabel}` : signed.label}
            />
          )}
        </View>

        <View style={[styles.divider, { backgroundColor: colors.border }]} />

        {/* Comments */}
        <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>Comments</Text>

        {!serverKnown ? (
          <EmptyNote text="Comments aren’t available for imported trails." />
        ) : !isApiConfigured() ? (
          <EmptyNote text="Comments are unavailable — no server is configured for this build." />
        ) : !commentWaypointId ? (
          <EmptyNote text="Comments aren’t supported for this waypoint." />
        ) : comments === null ? (
          <ActivityIndicator style={styles.loader} color={colors.accent} />
        ) : comments.length === 0 ? (
          <EmptyNote text="No comments yet. Be the first to leave a note." />
        ) : (
          comments.map((c) => {
            const isMine = !!session && c.authorId === session.userId;
            return (
              <CommentItem
                key={c.id}
                comment={c}
                isMine={isMine}
                // Only a synced comment by someone else can be reported — a
                // local row isn't on the server to moderate yet.
                canReport={!isMine && c.source === 'server'}
                reported={reportedIds.includes(c.id)}
                onReport={() => setReportTarget(c)}
                onOpenPhoto={setViewerUri}
                onDelete={async () => {
                  await deleteOwnComment({ id: c.id, source: c.source });
                  await load();
                }}
                onRetry={async () => {
                  await retryOutbox();
                  await load();
                }}
              />
            );
          })
        )}

        {remaining > 0 && (
          <Pressable
            onPress={() => setVisibleCount((count) => count + COMMENT_PAGE_SIZE)}
            accessibilityRole="button"
            accessibilityLabel={`Show earlier comments, ${remaining} remaining`}
            hitSlop={spacing.xs}
            style={styles.showEarlier}
          >
            <Text style={[styles.actionLink, { color: colors.accent }]}>
              {`Show earlier comments (${remaining} remaining)`}
            </Text>
          </Pressable>
        )}

        {isApiConfigured() && commentWaypointId && (
          <Composer
            waypointType={waypoint.type}
            registered={identityStatus === 'registered'}
            onSubmit={async ({ text, waterStatus, photo, displayName }) => {
              let activeSession = session;
              if (!activeSession) {
                if (!displayName) return; // guarded by the composer prompt
                activeSession = await useIdentityStore.getState().register(displayName);
              }
              await submitComment(
                { trailId, waypointId: commentWaypointId, text, waterStatus, photo, session: activeSession },
              );
              // Keep the whole window visible: the new row is the newest, so
              // widen by one rather than pushing the oldest out of the page.
              setVisibleCount((count) => count + 1);
              await load();
            }}
          />
        )}
      </ScrollView>

      {reportTarget && commentWaypointId && (
        <ReportDialog
          commentId={reportTarget.id}
          registered={identityStatus === 'registered'}
          onCancel={() => setReportTarget(null)}
          onSubmit={async ({ reason, detail, displayName }) => {
            let activeSession = session;
            if (!activeSession) {
              // Reports are authenticated, so a first-time reporter registers
              // here exactly as a first-time poster does in the composer.
              if (!displayName) return; // guarded by the dialog's name step
              activeSession = await useIdentityStore.getState().register(displayName);
            }
            await submitReport({
              commentId: reportTarget.id,
              trailId,
              waypointId: commentWaypointId,
              reason,
              detail,
              session: activeSession,
            });
            setReportedIds((ids) => [...ids, reportTarget.id]);
            setReportTarget(null);
          }}
        />
      )}

      <PhotoViewer uri={viewerUri} onClose={() => setViewerUri(null)} />
    </KeyboardAvoidingView>
  );
}

// ---------------------------------------------------------------------------
// Full-screen photo viewer
// ---------------------------------------------------------------------------

function PhotoViewer({ uri, onClose }: { uri: string | null; onClose: () => void }) {
  const { colors } = useTheme();
  return (
    <Modal
      visible={uri !== null}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable
        style={[styles.viewerBackdrop, { backgroundColor: colors.scrim }]}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close photo"
      >
        {uri ? (
          <Image
            source={{ uri }}
            style={styles.viewerImage}
            contentFit="contain"
            cachePolicy="disk"
            accessibilityIgnoresInvertColors
          />
        ) : null}
      </Pressable>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Favorite heart
// ---------------------------------------------------------------------------

function FavoriteHeart({ filled, onPress }: { filled: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={filled ? 'Remove from favorites' : 'Add to favorites'}
      accessibilityState={{ selected: filled }}
      hitSlop={spacing.sm}
      style={({ pressed }) => [styles.heart, pressed && styles.pressed]}
    >
      <Text style={[styles.heartIcon, { color: filled ? colors.waypointFavorite : colors.textSecondary }]}>
        {filled ? '♥' : '♡'}
      </Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Stat chip
// ---------------------------------------------------------------------------

function Stat({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.stat, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.statLabel, { color: colors.textSecondary }]}>{label}</Text>
      <Text style={[styles.statValue, { color: colors.textPrimary }]}>{value}</Text>
    </View>
  );
}

function EmptyNote({ text }: { text: string }) {
  const { colors } = useTheme();
  return <Text style={[styles.emptyNote, { color: colors.textSecondary }]}>{text}</Text>;
}

// ---------------------------------------------------------------------------
// Comment row
// ---------------------------------------------------------------------------

function WaterBadge({ status }: { status: WaterStatus }) {
  const { colors } = useTheme();
  const meta = waterStatusMeta(status);
  const color = colors[meta.colorToken];
  return (
    <View style={[styles.waterBadge, { borderColor: color }]}>
      <Text style={[styles.waterBadgeText, { color }]}>{meta.label}</Text>
    </View>
  );
}

function PhotoThumbnails({
  urls,
  onOpen,
}: {
  urls: string[];
  onOpen: (uri: string) => void;
}) {
  const { colors } = useTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.thumbRow}
    >
      {urls.map((uri, i) => (
        <Pressable
          key={`${uri}-${i}`}
          onPress={() => onOpen(uri)}
          accessibilityRole="imagebutton"
          accessibilityLabel={`Open photo ${i + 1}`}
          style={({ pressed }) => pressed && styles.pressed}
        >
          <Image
            source={{ uri }}
            style={[styles.thumb, { backgroundColor: colors.surface }]}
            contentFit="cover"
            cachePolicy="disk"
            transition={120}
            accessibilityIgnoresInvertColors
          />
        </Pressable>
      ))}
    </ScrollView>
  );
}

function CommentItem({
  comment,
  isMine,
  canReport,
  reported,
  onReport,
  onOpenPhoto,
  onDelete,
  onRetry,
}: {
  comment: CommentWithSyncState;
  isMine: boolean;
  canReport: boolean;
  reported: boolean;
  onReport: () => void;
  onOpenPhoto: (uri: string) => void;
  onDelete: () => void | Promise<void>;
  onRetry: () => void | Promise<void>;
}) {
  const { colors } = useTheme();
  const pending = comment.outboxStatus === 'pending' || comment.outboxStatus === 'sending';
  const failed = comment.outboxStatus === 'failed';
  const photoFailed = comment.photoUploadStatus === 'failed';
  const photoPending =
    comment.photoUploadStatus === 'pending' || comment.photoUploadStatus === 'sending';

  return (
    <View style={[styles.comment, { borderColor: colors.border }]}>
      <View style={styles.commentHead}>
        <Text style={[styles.author, { color: colors.textPrimary }]} numberOfLines={1}>
          {comment.authorName ?? 'Anonymous'}
        </Text>
        <Text style={[styles.date, { color: colors.textSecondary }]}>
          {relativeDate(comment.createdAt, Date.now())}
        </Text>
      </View>

      {comment.waterStatus && (
        <View style={styles.badgeRow}>
          <WaterBadge status={comment.waterStatus} />
        </View>
      )}

      {comment.body ? (
        <Text style={[styles.body, { color: colors.textPrimary }]}>{comment.body}</Text>
      ) : null}

      {comment.photoUrls.length > 0 && (
        <PhotoThumbnails urls={comment.photoUrls} onOpen={onOpenPhoto} />
      )}

      {(photoPending || photoFailed) && (
        <Text
          style={[styles.statusText, { color: photoFailed ? colors.danger : colors.textSecondary }]}
        >
          {photoFailed ? 'Photo failed to upload' : 'Uploading photo…'}
        </Text>
      )}

      {(pending || failed) && (
        <View style={styles.statusRow}>
          <Text
            style={[styles.statusText, { color: failed ? colors.danger : colors.textSecondary }]}
          >
            {failed ? 'Failed to send' : 'Waiting to send…'}
          </Text>
          {failed && (
            <Pressable onPress={onRetry} accessibilityRole="button" hitSlop={spacing.xs}>
              <Text style={[styles.actionLink, { color: colors.accent }]}>Retry</Text>
            </Pressable>
          )}
        </View>
      )}

      {(isMine || canReport) && (
        <View style={styles.rowActions}>
          {isMine && (
            <Pressable
              onPress={onDelete}
              accessibilityRole="button"
              accessibilityLabel="Delete comment"
              hitSlop={spacing.xs}
            >
              <Text style={[styles.actionLink, { color: colors.danger }]}>Delete</Text>
            </Pressable>
          )}
          {canReport &&
            (reported ? (
              <Text style={[styles.statusText, { color: colors.textSecondary }]}>Reported</Text>
            ) : (
              <Pressable
                onPress={onReport}
                accessibilityRole="button"
                accessibilityLabel="Report comment"
                hitSlop={spacing.xs}
              >
                <Text style={[styles.actionLink, { color: colors.textSecondary }]}>Report</Text>
              </Pressable>
            ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  notFoundTitle: { ...typography.displaySmall },

  hero: { gap: spacing.sm },
  heroTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heroActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  typeChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.full,
    maxWidth: '70%',
  },
  typeChipText: { ...typography.dataSmall, textTransform: 'capitalize' },
  name: { ...typography.displaySmall },
  description: { ...typography.body },

  heart: { padding: spacing.xs },
  heartIcon: { fontSize: glyphSizes.xxl },
  pressed: { opacity: 0.6 },

  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  stat: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    minWidth: 90,
  },
  statLabel: { ...typography.caption },
  statValue: { ...typography.titleSmall, fontVariant: ['tabular-nums'] },

  divider: { height: StyleSheet.hairlineWidth },
  sectionTitle: { ...typography.titleLarge },
  emptyNote: { ...typography.bodySmall, paddingVertical: spacing.md },
  loader: { paddingVertical: spacing.lg },

  comment: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  commentHead: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  author: { ...typography.titleSmall, flexShrink: 1 },
  date: { ...typography.caption },
  badgeRow: { flexDirection: 'row' },
  body: { ...typography.body },
  waterBadge: {
    alignSelf: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  waterBadgeText: { ...typography.caption, fontWeight: '600' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  statusText: { ...typography.caption },
  actionLink: { ...typography.titleSmall },
  rowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    alignSelf: 'flex-start',
    paddingTop: spacing.xs,
  },
  showEarlier: { alignSelf: 'flex-start', paddingVertical: spacing.sm },

  thumbRow: { flexDirection: 'row', gap: spacing.sm, paddingVertical: spacing.xs },
  thumb: { width: 76, height: 76, borderRadius: radii.md },

  viewerBackdrop: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  viewerImage: { width: '100%', height: '100%' },
});
