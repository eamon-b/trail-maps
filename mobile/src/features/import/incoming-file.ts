/**
 * "Open with Tracknotes" — the receive half of the import flow.
 *
 * The manifest half lives in `mobile/app.json`: Android intent filters for
 * `ACTION_VIEW`/`ACTION_SEND` of GPX and `.tracknotes.json`, and the iOS
 * `CFBundleDocumentTypes` / UTI declarations. Those make the OS offer
 * Tracknotes in a file manager's "open with" list and in the share sheet. This
 * module is what happens after the OS says yes: the launch URL arrives through
 * `expo-linking`, and a file URL is turned into a push onto the existing import
 * review screen.
 *
 * Three things are worth knowing about the shape of this:
 *
 * 1. **Not every incoming URL is a file.** The same `Linking` channel carries
 *    `tracknotes://` deep links, which are expo-router's business. This module
 *    claims `content://` and `file://` URLs and returns null for everything
 *    else — {@link classifyIncomingUrl} is the whole of that decision, and it is
 *    pure so the rule is testable without a device.
 *
 * 2. **The URI is copied into the cache before use.** An Android `content://`
 *    URI carries a read grant scoped to the activity that received the intent;
 *    it can stop resolving as soon as that activity is recreated (rotation, a
 *    process restart, Fast Refresh in dev). The review screen may sit unread
 *    for minutes, so {@link stageIncomingFile} takes a copy immediately and the
 *    screen only ever sees a `file://` URI it owns.
 *
 * 3. **`content://` reads go through `new File(uri).text()`.** In
 *    expo-file-system 57 the `File` class dispatches non-SAF content URIs to a
 *    `ContentProviderFile` backed by `ContentResolver.openInputStream` — its
 *    own docs name "share intent URIs" as a case it handles — so the modern API
 *    reads them directly and the legacy `readAsStringAsync` surface is not
 *    needed. What does *not* work on a content URI is anything routed through
 *    `javaFile` (`rename`, and `create` on a SAF URI), which is why staging
 *    writes a fresh file rather than copying in place.
 *
 * **Why `app.json` has four Android filters instead of one.** Android merges the
 * attributes of every `<data>` element inside a single `<intent-filter>` into
 * one set — schemes, MIME types and path patterns are unioned, not paired — so
 * a single filter carrying both `application/gpx+xml` and a `.*\\.gpx` path
 * pattern would silently require the *path* to end in `.gpx` even for the
 * precise MIME type, which an opaque `content://…/document/msf%3A1` never does.
 * The filters are therefore split by how they match: precise MIME with no path
 * gate, generic MIME (`text/xml`, `application/xml`,
 * `application/octet-stream`) gated on a `.gpx` name so Tracknotes does not
 * claim every octet-stream on the device, and the handoff JSON gated on
 * `.tracknotes.json`. The gated filters are `content://` only, because a path
 * pattern is consulted only when the filter declares an authority and
 * `host="*"` cannot match an authority-less `file:///…` URI — which is moot in
 * practice, since Android N+ blocks `file://` URIs in intents anyway.
 *
 * **Known gap — `ACTION_SEND`.** The Android share sheet delivers the payload in
 * `Intent.EXTRA_STREAM`, not in the intent's data URI, and `expo-linking` only
 * surfaces the latter. The SEND filters in `app.json` therefore put Tracknotes
 * in the share sheet, but the file will not arrive here until something reads
 * `EXTRA_STREAM` (a small config plugin or native module). `ACTION_VIEW` — the
 * "open with" path from a file manager, Downloads, or Gmail's attachment
 * preview — is fully wired.
 */

import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';
import { useRouter, useRootNavigationState } from 'expo-router';
import { useURL } from 'expo-linking';
import { Directory, File, Paths } from 'expo-file-system';
import { HANDOFF_EXTENSION } from '@lib/trail-handoff';

import { detectImportFormat } from './import-gpx';

/** Cache subdirectory holding the staged copy. Never more than one file. */
export const INCOMING_DIR = 'incoming';

/** Schemes that name a file rather than a deep link. */
const FILE_SCHEMES = new Set(['content', 'file']);

/**
 * Extensions this app claims. Anything else with a recognisable extension is
 * somebody else's file and is left alone.
 */
const ACCEPTED_EXTENSIONS = ['.gpx', '.json', '.xml'];

/** A file URL the OS handed us, plus whatever display name we could recover. */
export interface IncomingFile {
  /** `content://` or `file://` URI. */
  uri: string;
  /** Display name, or `''` when the URI is an opaque document id. */
  fileName: string;
}

/**
 * Decide whether a launch URL names a file this app should import.
 *
 * Returns null — meaning "not mine, leave it to expo-router" — for deep links,
 * `http(s)`, anything schemeless, and any file whose extension belongs to some
 * other app.
 *
 * A URI with *no* extension is accepted, not rejected. Android content URIs are
 * routinely opaque (`content://…/document/msf%3A1000000123`), and the OS has
 * already filtered by MIME type on our behalf before launching us; the file's
 * own bytes settle the format later via `detectImportFormat`. The cost of being
 * wrong is a parse error on a screen the user opened deliberately.
 */
export function classifyIncomingUrl(url: string | null | undefined): IncomingFile | null {
  if (!url) return null;
  const trimmed = url.trim();

  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed)?.[1]?.toLowerCase();
  if (!scheme || !FILE_SCHEMES.has(scheme)) return null;

  const fileName = fileNameFromUrl(trimmed);
  const lower = fileName.toLowerCase();

  if (ACCEPTED_EXTENSIONS.some(ext => lower.endsWith(ext))) return { uri: trimmed, fileName };
  // A recognisable extension we do not claim (.pdf, .jpg, …) is a hard no.
  if (/\.[a-z0-9]{1,8}$/.test(lower)) return null;
  return { uri: trimmed, fileName };
}

/**
 * Copy an incoming file into the app cache and return the URI to hand onward.
 *
 * The reported `fileName` is deliberately the *original* one — it is only ever
 * used to suggest a guide name — while the file on disk is named from the
 * sniffed format so the extension downstream is always trustworthy.
 *
 * The directory is wiped first rather than accumulating: staging is a handoff
 * between two screens milliseconds apart, so exactly one file needs to exist,
 * and a cache that grows once per share is a slow leak nobody would notice.
 */
export async function stageIncomingFile(incoming: IncomingFile): Promise<IncomingFile> {
  const text = await new File(incoming.uri).text();

  const dir = new Directory(Paths.cache, INCOMING_DIR);
  if (dir.exists) dir.delete();
  dir.create({ intermediates: true, idempotent: true });

  const staged = new File(dir, stagedFileName(incoming.fileName, text));
  staged.write(text);

  return { uri: staged.uri, fileName: incoming.fileName };
}

/** On-disk name for the staged copy: a fixed base plus the sniffed extension. */
export function stagedFileName(fileName: string, text: string): string {
  return detectImportFormat(fileName, text) === 'handoff'
    ? `incoming${HANDOFF_EXTENSION}`
    : 'incoming.gpx';
}

/** The `router.push` argument for a staged file — the review screen's contract. */
export function incomingImportRoute(staged: IncomingFile): {
  pathname: '/import';
  params: { uri: string; fileName: string };
} {
  return { pathname: '/import', params: { uri: staged.uri, fileName: staged.fileName } };
}

/**
 * Route files opened from outside the app into the import review screen.
 *
 * Mounted once, in the root layout. `useURL` covers both entry points — the
 * cold-start intent (via `getInitialURL`) and a URL delivered to an already
 * running app — so there is no separate initial-launch path to keep in sync.
 *
 * Navigation waits for `useRootNavigationState`: on a cold start this hook runs
 * before the navigator exists, and a `push` issued then is dropped.
 */
export function useIncomingFile(): void {
  const router = useRouter();
  const url = useURL();
  const navigationState = useRootNavigationState();
  const ready = navigationState?.key != null;

  // One import per URL. Without this a re-render (or the alert below closing)
  // would re-stage and re-push the same file.
  const handled = useRef<string | null>(null);

  useEffect(() => {
    if (!ready || !url || handled.current === url) return;

    const incoming = classifyIncomingUrl(url);
    if (!incoming) return;
    handled.current = url;

    let cancelled = false;
    stageIncomingFile(incoming)
      .then(staged => {
        if (cancelled) return;
        const route = incomingImportRoute(staged);
        router.push(route);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        Alert.alert(
          'Could not open that file',
          err instanceof Error ? err.message : 'The file could not be read.',
        );
      });

    return () => {
      cancelled = true;
    };
  }, [ready, url, router]);
}

/**
 * Best-effort display name from a URL's last path segment.
 *
 * Percent-decoding can throw on a malformed sequence, and a name is a nicety —
 * so a failure yields `''` and the caller carries on with the sniff.
 */
function fileNameFromUrl(url: string): string {
  const withoutQuery = url.split(/[?#]/, 1)[0];
  const segment = withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
