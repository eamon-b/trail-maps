# Tracknotes Privacy Policy

<!--
Maintainers: the public copy ships with the web app at `public/privacy.html`,
published at https://tracknotes.info/privacy.html (the Vercel deploy).
Keep the two in sync: change one and change the other.

The mobile app links that same URL from Settings → About (`PRIVACY_POLICY_URL`,
defined in `src/lib/contribution-licence.ts` and imported by
`mobile/src/features/settings/AboutSection.tsx`), and from the line under every
form that posts something publicly (`contributionPrivacyLine`). Still
outstanding before store submission: link the URL from the App Store / Play
Store listings (issue #31). Reviewed by the owner (2026-10-31); it has had no
legal read.
-->

**Last updated: 2026-10-31**

Tracknotes is a hiking guide app for long-distance trails, mostly in
Australia, with built-in guides for New Zealand, the United States and Japan,
and the option to import routes from anywhere. It is designed to work
offline-first and to collect as little personal information as possible.

In the app you can share information with other users, such as adding new
waypoints or commenting on waypoints. Our principle for anything you choose to
share publicly is that it is in the public domain, but you still control what
is available in our app: you can delete anything you have shared, edit shared
waypoints and community routes, and download community routes. Because shared
content is in the public domain, copies others have already made may remain.
The details are below.

## What we collect

**No account, no email, no password.** Tracknotes has no sign-up. The first
time you post a comment, share something or report something, the app
registers an anonymous device identity: a random device ID and the display name you choose. The
display name is the only identity shown to other users.

**Content you post.** Comments, water reports, and photos you attach to
waypoints, or to OpenStreetMap points of interest (shops, cafés, campgrounds
and the like) shown in the app, are stored on our servers and shown publicly to
other users of the app alongside your display name and the time of posting
(for a water report, also the time you say you saw the water).

**Photo location.** Photos are uploaded as taken: the app re-encodes them at a
reduced quality to make them smaller, but does not remove their metadata. A
photo may therefore keep its EXIF data, including the GPS location where it
was taken if your camera recorded one, and anyone who views or downloads the
photo can read it. This is deliberate, so other hikers can see exactly where a
photo was taken, as this is often useful information. If you do not want a
photo's location published, turn off location tagging in your camera app before
taking it, or do not attach it.

**Waypoints you share (optional).** You can add your own waypoints to a trail
on the phone. A waypoint you keep to yourself ("Only me") stays on your device
and is never sent to us. A waypoint you share with everyone is stored on our
servers and published: every user of the app sees it on that trail, and anyone
can read it through our public API. What is published is its position, name,
type and note, your display name, and when it was added and last edited. You
can edit it, make it private again, or delete it at any time; either of the
last two takes it off the app and the public API, but our copy is kept, marked
deleted, and our admins can still see it for moderation. A private waypoint can
still reach us inside a plan, if you choose it as a stop (see **Plans**).

**Location.** Your GPS position is used on-device to show where you are on the
trail and estimate arrival times. It is **never sent to our servers** on its
own. Places you have been or plan to be do reach us when you choose to send
them: a shared waypoint placed with "Use my location" is stored at that
position; a community route you share is a track you may have walked and
recorded, and its original GPX file, if you include it, can hold the times you
walked it; and a synced plan names the places you plan to stop at and how far
along the trail they are. Background location tracking is off by default and only runs
if you turn it on in Settings. Check-in sharing composes a message with your
position that is sent only through apps *you* choose in the system share sheet.

**Plans.** Once the app has a device identity (however it was created,
including by filing a report), the day plans you make for the built-in trails
are copied to our servers so they survive a reinstall and can
be opened in a linked browser. A plan holds its name, direction, start date,
the stops you chose with their nights, notes and "booked" ticks, the resupply
points you picked (and any zero days you plan at them), the alternate routes
you picked, and when it was last changed. A stop
carries the place's name and its distance along the trail, and that includes a
private waypoint of your own if you choose it as a stop. A plan is private to
your account unless you share it (below). Your walking pace and hours per day are not part of
it and stay on the device. Plans for trails you imported yourself, and for
community routes, stay on your device.

**Shared plan links (optional).** If you share a plan, we create a link with a
long random address. Anyone who has the link can see the plan and your display
name; it is not listed or searchable anywhere. You can stop sharing at any
time, after which the link no longer works.

**Linked browsers (optional).** You can link a web browser to your phone's
identity by typing a short code the phone shows (Settings → Linked browsers),
so the website can sync your plans and share routes. For each linked browser
we keep a sign-in token (stored on our side only as a one-way hash), the label
it was linked under (prefilled from the browser and operating system, such as
"Chrome on macOS", and editable), and when it was linked and last used. A
linked browser stays signed in for 180 days after it was last used, and you can
unlink it from the phone or from the browser at any time. An unlinked or lapsed
browser can no longer sign in, but its record (the label and those times) is
kept, marked revoked. On the website, the
sign-in token, your plans and any trails you import are kept in that browser's
own storage.

**Network addresses.** When the app registers a new device identity, and when a
browser enters a link code, we record the network address the request came from
(an IPv4 address, or for IPv6 the network prefix, the first half of the
address) with the time, so that one network cannot register accounts or guess
link codes without limit. These records hold no account ID and are deleted soon
after they are 24 hours old.

**No analytics, no advertising.** The app contains no analytics SDKs, ad
networks, or third-party trackers.

**Community routes (optional).** If you choose to share an imported route
with the community, we store the processed route (track, waypoints, distances
and elevation), the name, description, credit line and country/region you
enter, your display name at the time, and, if you include it, the original GPX
file you imported (on the website, untick "Include the original GPX file" to
leave it out). The route, its text and your display name are published publicly under
[CC0](https://creativecommons.org/publicdomain/zero/1.0/) (public domain) on
the website and in the app. The points of interest we add to a shared route
from OpenStreetMap (see **Searching OpenStreetMap** below) are not part of that
release: they are © OpenStreetMap contributors, under the Open Database
Licence, and the published route credits them as such. The original GPX file is kept privately, for
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

**Automated review of comments and shared waypoints.** The text of every new
comment, and the name and description of every new or edited shared waypoint,
is checked by an automated safety filter (the Llama Guard model, run by
Cloudflare, which already stores our data). When that filter flags a post, or
when an established user reports it, the post is sent to Anthropic's API (the
Claude model) for a review: for a comment, its text, its water status and the
time you say you saw the water, how many photos it has and the place it is on;
for a shared waypoint, its name, type, description and position; and, for
either, the reasons and notes of the reports filed against it. Your display
name, your account and your photos are not sent. A post the review finds
clearly abusive, spam or otherwise harmful is hidden at once until an admin
looks at it. The review's result is visible only to our admins. Anthropic
processes this data to return the review; it is not used to identify you.

**Searching OpenStreetMap (points of interest).** To find the shops, water,
campsites and other places near a route, three features send the route's
outline (a line of coordinates along it, never your name, device or account)
to public OpenStreetMap search servers (the Overpass API), which are run by
third parties under their own terms and see the outline and the network
address it came from:

- *Shared community routes.* Our server sends the outline of each published community route, after it is published, to these
  servers, one after another if one does not answer: overpass-api.de (run by
  FOSSGIS e.V., Germany), overpass.private.coffee (Private.coffee, Austria) and
  overpass.kumi.systems (Kumi Systems, Austria). The places found are added to
  the published route. Only routes that are already public are sent.
- *"Find places along this route" in the app.* When you ask for it on a guide
  you imported, your phone sends that guide's outline directly to the same
  three servers, tried in that order. Nothing goes through our server.
- *Points of interest for a trail imported on the website.* When you ask for
  them, your browser sends the outline directly to overpass-api.de, or to
  overpass.kumi.systems if that does not answer. Nothing goes through our
  server.

**Filling in missing elevation (optional).** When you import a GPX file
without elevation and choose to fill it in (on the app's import screen, or the
website's "Fetch elevation" button), your device sends the track's coordinates
directly to the public Open-Elevation service (api.open-elevation.com), which
returns the terrain height at each. Nothing goes through our server.

## Where data is stored

- **On your device:** downloaded maps, trail guides, your settings, favorites,
  routes, plans, your waypoints (private and shared), and a cached copy of
  comments and shared waypoints (so the app works offline).
- **On our servers:** posted comments, water reports, photos, shared
  waypoints, plans and their share links, display names, linked-browser
  records, moderation reports, the short-lived network-address records above,
  and any community routes you share (with their original GPX file, when you
  include it). These are stored with Cloudflare (D1 database and R2
  object storage). We request the Oceania location hint for the database;
  Cloudflare treats this as best-effort, so data may be stored or replicated
  in other regions (see `docs/data-residency.md` for the verification
  procedure and current status).

## Moderation and reporting

Every comment, every shared waypoint and every community route has a
**Report** action. Reports are reviewed and content that is abusive, unsafe, or
spam is removed. A comment or shared waypoint that an established user reports
is sent to the automated review above, and hidden at once if the review finds
it clearly abusive, spam or harmful; one that several established users report
is hidden whatever the review found, as is an unverified community route that
several established users report. Hidden content stays hidden until an admin
looks at it. Repeat abuse may result in a device being blocked from posting.

## Deleting your data

Settings → **Delete account** (on the phone) anonymises your device
identity on our servers: your display name is replaced with "Deleted user", and
the phone and every linked browser are signed out for good. It also deletes
every comment you posted, every waypoint you shared and every plan you saved
(they disappear from all devices on their next sync), including ones that were
already deleted or hidden:

- **Comments:** the text, water status and observation time are erased, and
  your uploaded photos are deleted.
- **Plans:** the plan's contents are erased and any shared plan link is
  removed, so it stops working.
- **Shared waypoints:** the name, note and position are erased, and the
  waypoint is unshared for good (moderation cannot restore it). On your phone
  they are kept as private waypoints.

What stays in our database for each is an empty record: its ID, the trail (and
waypoint or place) it belonged to, a waypoint's type, and when it was created,
changed and deleted, so that devices which synced it know to drop it. Reports
you filed are kept as a moderation record (the reason you chose and when), but
any text you wrote in them is erased. This is immediate and irreversible.

A community route you shared can be deleted at any time from its page
(**Delete**); this removes it from the public list and deletes the stored route
and GPX file. We keep a record of the route, marked removed: its name,
description, credit line, the display name it was shared under, its summary
statistics and a fingerprint of its track, which lets moderation stop a removed
route from being shared again. Because shared routes are released as CC0, copies others have
already downloaded or saved may remain on their devices. Deleting your account
leaves the routes you shared public but removes your display name from them:
the stored route is rewritten without it and the earlier copies that named you
are deleted. The original GPX file, if you included one, is deleted too. The
description and credit line you wrote stay published. Delete the routes first
if you want them gone. Local data on your own device (favorites, routes,
downloaded maps) stays on your device until you clear it or uninstall.

## Children

Tracknotes is not directed at children under 13 and does not knowingly
collect personal information from them.

## Contact

Questions or removal requests:
[privacy@tracknotes.info](mailto:privacy@tracknotes.info)

## Changes

We will update this page and the "Last updated" date when the policy changes.
