# Tracknotes Privacy Policy (draft)

_Draft for review. The public copy ships with the web app at
`public/privacy.html`, published at
**<https://trail-maps.vercel.app/privacy.html>** (the Vercel deploy) — keep the
two in sync._

_The mobile app links that same URL from Settings → About
(`PRIVACY_POLICY_URL` in `mobile/src/features/settings/AboutSection.tsx`);
change one and change the other. Still outstanding before store submission:
link the URL from the App Store / Play Store listings, and give this draft a
human read (issue #31)._

**Last updated: 2026-10-07**

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

**Community routes (optional).** If you choose to share an imported route
with the community, we store the processed route (track, waypoints, distances
and elevation), the name, description, credit line and country/region you
enter, your display name at the time, and, if you include it, the original GPX
file you imported (on the website, untick "Include the original GPX file" to
leave it out). The route, its text and your display name are published publicly under
[CC0](https://creativecommons.org/publicdomain/zero/1.0/) (public domain) on
the website and in the app; the original GPX file is kept privately, for
re-processing only, under an unguessable address that is never linked or
shown publicly. If a route is hidden by moderation, its published copy is
taken down until it is restored. Sharing is opt-in: an import
you do not share never leaves your device. The published route carries no
recording times: timestamps are dropped from the processed route before it is
stored or published. A raw GPX file can still hold them, along with your name
or device, which is why it is kept only privately and is yours to leave out.

**Automated review of community routes.** Each shared route is checked
automatically, and its text, region, summary statistics, waypoint names, a
sample of its waypoint descriptions, the names of its alternate routes and side
trips, and a sample of its coordinates are sent to Anthropic's API (the Claude model) for an
automated review that helps our admins spot spam, abuse or routes that are not
walking routes. Anthropic processes this data to return the review; it is not
used to identify you. The review's result is visible to you and to our admins,
not to the public.

## Where data is stored

- **On your device:** downloaded maps, trail guides, your settings, favorites,
  routes, plans, and a cached copy of comments (so the app works offline).
- **On our servers:** posted comments, water reports, photos, display names,
  moderation reports, and any community routes you share (with their original
  GPX file, when you include it). These are stored with Cloudflare (D1 database and R2
  object storage). We request the Oceania location hint for the database;
  Cloudflare treats this as best-effort, so data may be stored or replicated
  in other regions (see `docs/data-residency.md` for the verification
  procedure and current status).

## Moderation and reporting

Every comment and every community route has a **Report** action. Reports are reviewed and content that
is abusive, unsafe, or spam is removed. Repeat abuse may result in a device
being blocked from posting.

## Deleting your data

Settings → Account → **Delete account** removes your device identity from our
servers, soft-deletes every comment you posted (they disappear from all
devices on their next sync), and deletes your uploaded photos. This is
immediate and irreversible. A community route you shared can be deleted at any
time from its page (**Delete**); this removes it from the public list and
deletes the stored route and GPX file. Because shared routes are released as
CC0, copies others have already downloaded or saved may remain on their
devices. Deleting your account leaves the routes you shared public but removes
your display name from them; delete them first if you want them gone. Local data on your own device (favorites, routes,
downloaded maps) stays on your device until you clear it or uninstall.

## Children

Tracknotes is not directed at children under 13 and does not knowingly
collect personal information from them.

## Contact

Questions or removal requests: privacy@contour-map-tiles.net

## Changes

We will update this page and the "Last updated" date when the policy changes.
