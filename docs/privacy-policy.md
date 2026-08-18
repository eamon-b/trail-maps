# Tracknotes Privacy Policy (draft)

_Draft for review. The public copy ships with the web app at
`public/privacy.html` (served at `<site>/privacy.html` on the Vercel deploy) —
keep the two in sync. Before store submission: link that URL from the store
listings and from the app's Settings screen._

**Last updated: 2026-08-19**

Tracknotes is a hiking guide app for Australian long-distance trails. It is
designed to work offline-first and to collect as little personal information
as possible.

## What we collect

**No account, no email, no password.** Tracknotes has no sign-up. When you
first post a comment, the app registers an anonymous device identity: a random
device ID and the display name you choose. The display name is the only
identity shown to other users.

**Content you post.** Comments, water reports, and photos you attach to
waypoints are stored on our servers and shown publicly to other users of the
app alongside your display name and the time of posting.

**Location.** Your GPS position is used on-device to show where you are on the
trail and estimate arrival times. It is **never sent to our servers**.
Background location tracking is off by default and only runs if you turn it on
in Settings. Check-in sharing composes a message with your position that is
sent only through apps *you* choose in the system share sheet.

**No analytics, no advertising.** The app contains no analytics SDKs, ad
networks, or third-party trackers.

## Where data is stored

- **On your device:** downloaded maps, trail guides, your settings, favorites,
  routes, plans, and a cached copy of comments (so the app works offline).
- **On our servers:** posted comments, water reports, photos, display names,
  and moderation reports. These are stored with Cloudflare (D1 database and R2
  object storage). We request the Oceania location hint for the database;
  Cloudflare treats this as best-effort, so data may be stored or replicated
  in other regions (see `docs/data-residency.md` for the verification
  procedure and current status).

## Moderation and reporting

Every comment has a **Report** action. Reports are reviewed and content that
is abusive, unsafe, or spam is removed. Repeat abuse may result in a device
being blocked from posting.

## Deleting your data

Settings → Account → **Delete account** removes your device identity from our
servers, soft-deletes every comment you posted (they disappear from all
devices on their next sync), and deletes your uploaded photos. This is
immediate and irreversible. Local data on your own device (favorites, routes,
downloaded maps) stays on your device until you clear it or uninstall.

## Children

Tracknotes is not directed at children under 13 and does not knowingly
collect personal information from them.

## Contact

Questions or removal requests: barretteamon@gmail.com

## Changes

We will update this page and the "Last updated" date when the policy changes.
