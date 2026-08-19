/**
 * Guide header overflow menu — the ⋯ trigger plus its anchored popover.
 *
 * Preview for issue #26: the guide header shipped four always-visible glyph
 * actions (⋔ ▤ ⤓ ⚙) beside the title, and React Navigation truncates the
 * *title*, not the buttons — so long guide names ("Hume & Hovell") get
 * squeezed. This folds the guide-scoped actions behind one ⋯ button.
 *
 * Built from the same primitives every other overlay in the app uses (a
 * transparent `Modal` over a scrim-tinted backdrop, see ReportDialog /
 * DeleteAccountSection) rather than a new dependency — this must stay a
 * JS-only change with no prebuild impact.
 *
 * The popover right-aligns under the trigger. Its vertical anchor is measured
 * from the trigger itself, because the header's height varies with the status
 * bar / display cutout and there is no SafeAreaProvider mounted to ask.
 */

import React, { useCallback, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useReduceMotion, useTheme } from '../../theme';
import { glyphSizes, radii, spacing, touchTarget, typography } from '../../tokens';

export interface GuideMenuItem {
  /** Stable identity for React and for tests. */
  key: string;
  /** Visible and spoken label. */
  label: string;
  /** Text glyph shown ahead of the label — the same ones the header used. */
  glyph: string;
  onPress: () => void;
}

/**
 * Where the popover sits before the trigger has been measured. Only ever used
 * for a frame on first render (and under `react-test-renderer`, which has no
 * layout engine), so a plausible header height is enough.
 */
const FALLBACK_ANCHOR_TOP = touchTarget.field;

export function GuideHeaderMenu({
  items,
  tintColor,
  label = 'More actions',
}: {
  items: GuideMenuItem[];
  /** Color for the ⋯ glyph — the header tint, since it sits on the accent bar. */
  tintColor: string;
  label?: string;
}) {
  const { colors } = useTheme();
  const reduceMotion = useReduceMotion();
  const [open, setOpen] = useState(false);
  const [anchorTop, setAnchorTop] = useState<number>(FALLBACK_ANCHOR_TOP);
  const triggerRef = useRef<View>(null);

  // `onLayout` fires in the header's coordinate space, so it is only a signal
  // to re-measure against the window. Null-safe: the ref is null under the
  // test renderer, which leaves the fallback anchor in place.
  const measure = useCallback(() => {
    triggerRef.current?.measureInWindow?.((_x, y, _width, height) => {
      setAnchorTop(y + height + spacing.xs);
    });
  }, []);

  const close = useCallback(() => setOpen(false), []);

  const openMenu = useCallback(() => {
    measure();
    setOpen(true);
  }, [measure]);

  const select = useCallback((item: GuideMenuItem) => {
    // Close first: the menu is mounted by the guide's header, which stays
    // mounted underneath a pushed screen — leaving it visible would float the
    // popover over the destination.
    setOpen(false);
    item.onPress();
  }, []);

  return (
    <>
      <View ref={triggerRef} onLayout={measure} collapsable={false}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityHint="Opens the guide actions menu"
          accessibilityState={{ expanded: open }}
          onPress={openMenu}
          style={styles.trigger}
          hitSlop={spacing.sm}
        >
          <Text style={[styles.triggerGlyph, { color: tintColor }]}>⋯</Text>
        </Pressable>
      </View>

      <Modal
        visible={open}
        transparent
        animationType={reduceMotion ? 'none' : 'fade'}
        onRequestClose={close}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close menu"
          onPress={close}
          style={[styles.backdrop, { backgroundColor: colors.scrim }]}
        />
        <View
          accessibilityRole="menu"
          accessibilityLabel={label}
          accessibilityViewIsModal
          style={[
            styles.menu,
            { top: anchorTop },
            { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
          ]}
        >
          {items.map((item, index) => (
            <Pressable
              key={item.key}
              accessibilityRole="menuitem"
              accessibilityLabel={item.label}
              onPress={() => select(item)}
              style={[
                styles.item,
                index > 0 && styles.itemDivided,
                index > 0 && { borderTopColor: colors.borderSubtle },
              ]}
            >
              <Text style={[styles.itemGlyph, { color: colors.accent }]}>{item.glyph}</Text>
              <Text style={[styles.itemLabel, { color: colors.textPrimary }]}>{item.label}</Text>
            </Pressable>
          ))}
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    paddingHorizontal: spacing.sm,
    minHeight: touchTarget.min,
    justifyContent: 'center',
  },
  triggerGlyph: {
    fontSize: glyphSizes.lg,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  menu: {
    position: 'absolute',
    right: spacing.md,
    minWidth: 200,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.xs,
    overflow: 'hidden',
    // shadowColor is exempt from the design-token color rule: shadows are
    // intentionally black in every theme.
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: touchTarget.min,
    paddingHorizontal: spacing.lg,
  },
  itemDivided: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  itemGlyph: {
    fontSize: glyphSizes.md,
    width: glyphSizes.xl,
    textAlign: 'center',
  },
  itemLabel: {
    ...typography.body,
  },
});
