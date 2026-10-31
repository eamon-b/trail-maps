# Legal & Licensing Posture (user-contributed content)

The project's decisions on what hikers contribute: the licence it is given
under, how hiker-reported water is presented, the Australian Privacy Principles
posture, and moderation and takedown. It records *why*; what users are told is
in the user-facing drafts, which win if this note disagrees with them:

- `docs/privacy-policy.md` (published as `public/privacy.html`): what is
  collected, where it is stored, and what deleting an account removes.
- `docs/terms-of-service.md` (published as `public/terms.html`): the CC0 grant,
  acceptable use, moderation and the liability disclaimer.
- `docs/data-residency.md`: where Cloudflare actually holds the data, and why
  residency is never promised.
- `docs/architecture/workers.md`: how the comments API implements all of it.

Both drafts were written by AI and reviewed by the owner. Neither has had a
legal read (#148 tracks the terms). The store listings must still link them
(#31).

Rewritten 2026-10-30 (issue #232) against the shipped Cloudflare backend.

## What is contributed

Everything a hiker publishes goes through the comments API
(`workers/comments-api/`, Cloudflare D1 + R2) under an anonymous device
identity: a random id, a sign-in token held server-side only as a hash, and the
display name the hiker chooses. There is no email, password or sign-up.

- **Comments** at a curated waypoint, a community route's waypoint, a shared
  waypoint or an OpenStreetMap POI, optionally with a water status
  (`flowing`/`low`/`dry`), an observation time and photos.
- **Shared waypoints** (`hw_`): position, name, type and note.
- **Community routes**: the processed route, its text and region, and
  optionally the original GPX, kept privately.
- **Plans** synced for the built-in trails. Private to the account unless the
  hiker makes a share link; not a public contribution.

## Decisions

1. **Contribution licensing: CC0, granted when posting.** Comments (with their
   water reports and photos), shared waypoints and community routes are
   dedicated to the public domain under CC0 1.0. A line under every form that
   publishes something says so and links the terms (`contributionLicenceLine`
   and `TERMS_URL` in `src/lib/contribution-licence.ts`): the phone's comment
   composer, its waypoint form and its route-share form
   (`ContributionLicence.tsx`), and the web's route-share form and the route
   owner's Edit form, which republishes the route's text
   (`renderContributionLicence` in `src/web/community-ui.ts`). Sharing a
   community route also needs a tick: "I recorded this track myself, or it is
   openly licensed, and I release it under CC0 (public domain)"
   (`src/web/upload.html`, `mobile/src/features/community/share-form.ts`). The
   terms add a fallback licence where CC0 cannot waive a right. CC0 rather than CC-BY-SA because:
   - attribution stacking is unworkable across hundreds of small contributions
     shown together;
   - ShareAlike would arguably reach the published trail-data files and
     complicate any future licensing of the dataset;
   - CC0 data can go into OpenStreetMap (ODbL) without a waiver, where CC-BY-SA
     cannot, and contributing water-point data upstream is worth more than
     attribution.

   The display name shown beside a contribution is a courtesy, not a licence
   term.

   *Community routes and OpenStreetMap POIs (issue #163).* CC0 covers only what
   the hiker contributes: the route, its waypoints and text, and the display
   name. The POIs the comments API adds to a published route
   (`enrichCommunityRoutePois`) are OpenStreetMap data, © OpenStreetMap
   contributors under the ODbL, and are never relicensed: they sit in their own
   `pois` array, and the route's `config.dataSource` says so ("…under CC0.
   Points of interest © OpenStreetMap contributors, under the Open Database
   Licence (ODbL), not CC0.", linking openstreetmap.org/copyright), as the
   bundled trails' POIs are credited to OSM in `pois.json` and in the app's map
   credits. The API's `licence: 'CC0-1.0'` describes the hiker's contribution,
   not the POIs. The same split holds for an import's POIs on the phone and the
   web, which never leave the device.

2. **Hiker-reported water: attribution, no gate.** Water status is the one
   datum where a wrong value can hurt someone. The controls:
   - *Attribution.* Another hiker's shared waypoint carries "Reported by
     <name> · <date>" (`hikerReportLine`, #167) on the phone's List pane row
     (read to screen readers too) and on the waypoint screen. That line is what
     sets it apart from curated data and from the hiker's own ("Added by you").
     There is no hedging or advice: the hiker judges it, and another hiker's
     shared water still counts in the carry calculators (decided 2026-10-18).
   - *Freshness.* Water reports on comments are shown as a ranked verdict with
     its age ("Flowing · 3 days ago"), not as the newest row: reports older
     than 120 days are ignored and the rest decay with a 30-day constant, so
     one recent "dry" outweighs a stack of old "flowing"
     (`mobile/src/features/guide/water-aggregate.ts`).
   - *No one-time acknowledgement* (decided 2026-10-19, issue #144). The first
     draft required one before community water data was first shown; the
     attribution replaces it, and nothing is put in the hiker's way.
   - *Terms.* The terms disclaim reliance on user-posted information "to the
     maximum extent permitted by law" and preserve the Australian Consumer Law
     guarantees, which a blanket disclaimer cannot exclude. That wording is
     part of the legal read in #148.

3. **Australian Privacy Act 1988 (APPs): comply, though probably exempt.** The
   project has no revenue, far under the $3M small-business threshold, so much
   of the Act may not strictly apply. It complies anyway (confirmed by the
   owner, 2026-10-30): it is cheap at this scale.
   - *APP 1/5, open and notified.* The privacy policy is published at
     `public/privacy.html` and linked from the phone's Settings → About
     (`PRIVACY_POLICY_URL`). The notice at collection is a second line under
     every form that publishes something, beside the licence line: "The
     privacy policy says what is stored and who can see it."
     (`contributionPrivacyLine`, decided 2026-10-30). The store listings must
     link the policy too (#31).
   - *APP 3, minimal collection.* No name, email, phone or account. What is
     held: the device identity and display name, what the hiker chooses to
     post, linked-browser records, and network addresses for rate limiting
     (deleted soon after 24 hours, with no account id). Location is not absent:
     a shared waypoint placed with "Use my location", a community route's
     track and optional raw GPX (which can hold recording times; the
     processed route drops them), a photo's EXIF GPS (photos are re-encoded
     but their metadata is kept, deliberately, and the policy says so), and a
     synced plan's stops. Each is posted by the hiker's choice, and the policy
     names each one. GPS position is never sent on its own.
   - *Times are published as posted* (decided 2026-10-30). A comment's posting
     time and a water report's `observedAt` (only clamped against the future:
     `clampObservedAt`) are public to the second; the first draft planned to
     round the observation time to the day, so a report could not place a
     hiker at a tank at a given hour. Rounding `observedAt` alone would protect
     little: the posting time beside it is exact, the feeds and sync depend on
     it, and a photo's EXIF carries its own time and place. Posting is opt-in,
     and the policy says both times are public.
   - *APP 6, use.* Data is used to run the service and to moderate it. There
     is no analytics, advertising or third-party tracking.
   - *APP 8, cross-border disclosure.* Data is stored with Cloudflare under an
     Oceania location hint, which is best-effort, so the policy says it may be
     stored or replicated in other regions and never promises residency
     (`docs/data-residency.md`). Two other disclosures leave Australia, and the
     policy names both: a community route's text and a sample of its
     coordinates, and a reported or screen-flagged comment's or shared
     waypoint's text with its reports, go to Anthropic's API for the automated
     reviews, and a route's
     outline (never an identity) goes to the public Overpass instances named in
     the policy. An instance is added to the policy before it is added to the
     code (`OVERPASS_ENDPOINTS`, `INTERACTIVE_OVERPASS_ENDPOINTS`; #231).
   - *APP 11, security.* Sign-in and linked-browser tokens are stored only as
     one-way hashes. Admin actions need an account flagged admin in D1.
     Private objects in R2 (a community route's canonical JSON and raw GPX)
     sit at unguessable keys that are never returned. Every write is rate
     limited per account, and account registration and link codes per network.
   - *APP 12/13, access, correction and deletion.* Settings → Delete account
     calls `DELETE /v1/me`, which works by **anonymising in place, not deleting
     rows**. The display name becomes "Deleted user", every token is revoked,
     and the account's comments (text, water status, observation time, photos),
     shared waypoints (name, note, position) and plans (contents and share
     link) are erased to empty tombstones. The tombstones are kept so that
     synced devices drop them. The account's community routes stay published
     under CC0 but are de-attributed: the route is rewritten without the
     display name, older public copies are purged, and the raw GPX is deleted.
     Reports the account filed keep their reason but lose any text. Requests
     by email to the policy's contact address are handled the same way. The
     reasons for this shape:
     - a privacy request must never silently change what other hikers rely on
       (a community route, the water history of a source);
     - CC0 copies others already hold cannot be recalled.

     The privacy policy states exactly what remains.

4. **Moderation and takedown: post-moderation, report-driven.** Content is
   published when posted. Every comment, shared waypoint and community route
   has a Report action.
   - One qualifying report (an account at least 24 hours old, not the
     author, filed since the last admin restore) sends a comment or shared
     waypoint to an automated review (Claude), which hides it at once only
     when it is confident the post is clearly bad: spam, scams, abuse, hate,
     sexual content, a private person's details, deliberately dangerous
     falsehoods, vandalism (decided 2026-10-31). Every new comment and shared
     waypoint is also screened by Llama Guard on Workers AI, whose flag only
     starts that review. The review fails open, never re-hides a post an
     admin restored, and is seen only by admins.
   - Three distinct qualifying reporters hide a comment, a shared waypoint or
     an unverified community route until an admin looks at it, whatever the
     review said: the backstop when it is unsure, wrong or down.
   - Community routes also get an automated review on submission. It fails
     open, and only a confident reject hides an unverified route.
   - Photos are not reviewed by any model. Cloudflare's CSAM Scanning Tool is
     the intended check on them (`docs/architecture/workers.md`, "Comment and
     waypoint review").
   - Admins can hide, restore, delete, and ban an account, with or without its
     content (`src/web/admin-moderation.html`).
   - Takedown requests (copyright complaints, land managers asking to remove a
     sensitive site) come through Report or the contact email. The target is
     acknowledgement within 72 hours, and land-manager requests are honoured
     by default.
   - The terms are accepted by posting: the licence line under every form that
     publishes something links them ("By posting, you … agree to the terms of
     service").

## Open questions for the legal read

- **Takedown contact.** Takedowns and privacy requests share one address
  (`privacy@tracknotes.info`), and no response time is committed for
  privacy requests.
