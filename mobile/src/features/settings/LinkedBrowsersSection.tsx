/**
 * Settings' "Linked browsers" section — how the website gets to see this
 * account's plans.
 *
 * There is no password to type into a browser, so the phone mints a
 * short-lived code instead (`POST /v1/link-codes`) and the browser exchanges it
 * for a token of its own. The phone is therefore the authority over who is
 * signed in, which is why the device list and its Remove buttons live here and
 * not on the website.
 *
 * Shape follows `DisplayNameSection`, including its two-state rule: identity is
 * read asynchronously from the keystore, so the section renders nothing until
 * it knows which state it is in, and an account-less device gets one
 * explanatory line rather than a button that cannot work (registration happens
 * on first post, not here).
 *
 * The code is shown large, monospaced and grouped 4-4 because it is read off
 * this screen and typed into another device, and it carries a live countdown
 * because a code that has quietly expired looks exactly like one that has not.
 * There is no Copy button and no QR: the phone has no clipboard module and no
 * QR library, and neither is worth a native dependency for eight characters
 * that are being typed somewhere else anyway (plans/day-planner.md).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { DeviceTokenSummary, LinkCodeResponse } from '@lib/comments-api-types';
import { useTheme } from '../../theme';
import { radii, spacing, touchTarget, typography } from '../../tokens';
import { isApiConfigured } from '../../api/client';
import { apiErrorMessage } from '../../api/error-message';
import { fetchDevices, requestLinkCode, revokeLinkedDevice } from '../../api/link';
import { useIdentityStore } from '../../state/identity-store';
import {
  deviceSubtitle,
  deviceTitle,
  formatCountdown,
  groupCode,
  isRemovable,
  secondsUntil,
} from './linked-browsers';

export const LINK_CODE_FAILED_MESSAGE = "Couldn't get a link code. Please try again.";
export const DEVICES_FAILED_MESSAGE = "Couldn't load your linked browsers.";
export const REVOKE_FAILED_MESSAGE = "Couldn't remove that browser. Please try again.";

/** What to do with the code, said once, where the code is. */
export const LINK_INSTRUCTION = 'On the website open a plan → Sync → enter this code.';

export function LinkedBrowsersSection() {
  const { colors } = useTheme();
  const status = useIdentityStore((s) => s.status);

  const [code, setCode] = useState<LinkCodeResponse | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [devices, setDevices] = useState<DeviceTokenSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * Read the device list.
   *
   * Written as promise callbacks rather than `await` so every `setState` runs
   * in a callback, never synchronously in an effect body — the shape React's
   * `set-state-in-effect` rule asks for, and the reason this is not an async
   * function.
   */
  const loadDevices = useCallback(
    () =>
      fetchDevices().then(
        (list) => {
          if (mounted.current) setDevices(list);
        },
        (err: unknown) => {
          // A failed list is not worth blocking the section: the button above
          // it still works, and the error line says what happened.
          if (mounted.current) {
            setDevices([]);
            setError(apiErrorMessage(err, DEVICES_FAILED_MESSAGE));
          }
        },
      ),
    [],
  );

  useEffect(() => {
    if (status !== 'registered') return;
    void loadDevices();
  }, [status, loadDevices]);

  // The countdown is the only thing that makes an expired code visibly expired.
  // It also drives the re-read of the device list on expiry: by then the
  // browser has either used the code or not, and the list is the answer.
  useEffect(() => {
    if (!code) return;
    const tick = () => {
      const left = secondsUntil(code.expiresAt, Date.now());
      setSecondsLeft(left);
      if (left === 0) {
        setCode(null);
        void loadDevices();
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [code, loadDevices]);

  const onLink = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await requestLinkCode();
      if (mounted.current) setCode(next);
    } catch (err) {
      if (mounted.current) setError(apiErrorMessage(err, LINK_CODE_FAILED_MESSAGE));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [busy]);

  const onRemove = useCallback(
    async (id: string) => {
      if (removing) return;
      setRemoving(id);
      setError(null);
      try {
        await revokeLinkedDevice(id);
        if (mounted.current) setDevices((list) => (list ?? []).filter((d) => d.id !== id));
      } catch (err) {
        if (mounted.current) setError(apiErrorMessage(err, REVOKE_FAILED_MESSAGE));
      } finally {
        if (mounted.current) setRemoving(null);
      }
    },
    [removing],
  );

  // Still reading the keystore, or a build with no comments server at all.
  if (status === 'unknown') return null;
  if (status === 'anonymous' && !isApiConfigured()) return null;

  return (
    <View style={styles.section}>
      <Text style={[styles.label, { color: colors.textSecondary }]}>Linked browsers</Text>

      <View
        style={[
          styles.panel,
          { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
        ]}
      >
        {status !== 'registered' ? (
          <Text style={[styles.hint, { color: colors.textSecondary }]}>
            You’ll get an account when you post your first comment. After that you can link a
            browser here to see your plans on the website.
          </Text>
        ) : (
          <>
            {code ? (
              <View style={styles.codeBlock}>
                <Text
                  style={[styles.code, { color: colors.textPrimary }]}
                  accessibilityLabel={`Link code ${code.code.split('').join(' ')}`}
                  selectable
                >
                  {groupCode(code.code)}
                </Text>
                <Text style={[styles.hint, { color: colors.textSecondary }]}>
                  {LINK_INSTRUCTION}
                </Text>
                <Text style={[styles.countdown, { color: colors.textSecondary }]}>
                  Expires in {formatCountdown(secondsLeft)}
                </Text>
              </View>
            ) : (
              <Pressable
                onPress={() => void onLink()}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel="Link a browser"
                accessibilityState={{ disabled: busy }}
                style={[
                  styles.action,
                  styles.primaryAction,
                  { backgroundColor: colors.accent },
                  busy && styles.disabled,
                ]}
              >
                {busy ? (
                  <ActivityIndicator color={colors.accentText} />
                ) : (
                  <Text style={[styles.actionLink, { color: colors.accentText }]}>
                    Link a browser
                  </Text>
                )}
              </Pressable>
            )}

            {error ? (
              <Text style={[styles.error, { color: colors.danger }]} accessibilityRole="alert">
                {error}
              </Text>
            ) : null}

            {devices === null ? (
              <ActivityIndicator color={colors.textSecondary} />
            ) : devices.length === 0 ? (
              <Text style={[styles.hint, { color: colors.textSecondary }]}>
                Nothing is signed in to this account yet.
              </Text>
            ) : (
              devices.map((device) => (
                <View key={device.id} style={[styles.row, { borderTopColor: colors.border }]}>
                  <View style={styles.rowMain}>
                    <Text style={[styles.rowValue, { color: colors.textPrimary }]} numberOfLines={1}>
                      {deviceTitle(device)}
                    </Text>
                    <Text style={[styles.rowLabel, { color: colors.textSecondary }]}>
                      {deviceSubtitle(device)}
                    </Text>
                  </View>
                  {isRemovable(device) ? (
                    <Pressable
                      onPress={() => void onRemove(device.id)}
                      disabled={removing !== null}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${deviceTitle(device)}`}
                      hitSlop={spacing.sm}
                      style={styles.action}
                    >
                      {removing === device.id ? (
                        <ActivityIndicator color={colors.danger} />
                      ) : (
                        <Text style={[styles.actionLink, { color: colors.danger }]}>Remove</Text>
                      )}
                    </Pressable>
                  ) : null}
                </View>
              ))
            )}
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.sm },
  label: { ...typography.titleLarge },
  panel: {
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  codeBlock: { gap: spacing.xs, alignItems: 'center' },
  code: {
    ...typography.displaySmall,
    fontFamily: 'monospace',
    letterSpacing: 4,
  },
  countdown: { ...typography.caption, fontVariant: ['tabular-nums'] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.sm,
  },
  rowMain: { flex: 1, gap: spacing.xs },
  rowLabel: { ...typography.caption },
  rowValue: { ...typography.body },
  hint: { ...typography.bodySmall },
  error: { ...typography.bodySmall },
  action: {
    minHeight: touchTarget.min,
    minWidth: touchTarget.min,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.sm,
  },
  primaryAction: { paddingHorizontal: spacing.lg, alignSelf: 'flex-start' },
  disabled: { opacity: 0.5 },
  actionLink: { ...typography.titleSmall },
});
