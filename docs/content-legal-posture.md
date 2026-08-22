# Legal & Licensing Posture (user-contributed content)

> Extracted verbatim from the retired `plans/part-6b-crowdsourcing-design.md` §8
> (deleted 2026-08-22 with the rest of the pre-rebuild plans). The **decisions**
> below — CC0 for contributions, the safety-critical water disclaimer, the
> Australian Privacy Principles posture, and the ToS/takedown shape — are still
> the project's position and none of them have shipped yet (a ToS and the CC0
> notice are still outstanding; see issue #31).
>
> **Stale infrastructure references.** The text was written against the Supabase
> design that was never built. Read "Supabase Sydney", "RLS", "Edge Function",
> "pre-moderated", "the weekly fold", and the `devices`/submissions schema as
> the shipped equivalents: Cloudflare D1 + R2 (`workers/comments-api/`),
> anonymous device-token auth, live **post**-moderation with a report/flag
> endpoint, and `DELETE /v1/me` (soft-delete + anonymize) for APP 12/13. Current
> storage placement is tracked in `docs/data-residency.md`; what is actually
> disclosed to users is in `docs/privacy-policy.md`.

---

## 8. Legal

**Decisions:**

1. **Contribution licensing — CC0 (public domain dedication), granted at submission
   time.** The submit sheet's first-use notice includes: *"Contributions are dedicated
   to the public domain (CC0) so they can be freely redistributed, including in this
   app and other mapping projects."* CC0 is chosen over CC-BY-SA because: (a)
   attribution stacking is unworkable when hundreds of micro-contributions are folded
   into one JSON artifact; (b) ShareAlike would arguably contaminate the published
   trail-data files and complicate any future licensing of the dataset; (c) **OSM
   compatibility** — CC0 data can be ingested into OpenStreetMap (ODbL) without a
   waiver, whereas CC-BY-SA is not ODbL-compatible; keeping the door open to
   contributing water-point data upstream to OSM is worth more than attribution. The
   in-app display-name credit for linked users (Section 5) is a product courtesy, not
   a license term.
2. **Safety-critical water-data disclaimer.** Water status is the one datum where a
   wrong value can hurt someone. Required: a one-time acknowledgement before community
   water data is first displayed, persistent "reported <date> by hikers — conditions
   change, always carry contingency water" phrasing on `waterStatus` UI (the existing
   `unknown`-when-stale rule in Section 2.3 is itself a safety control), and a ToS
   clause disclaiming reliance on user-submitted data to the extent permitted by the
   Australian Consumer Law (blanket disclaimers can't exclude ACL consumer guarantees,
   so the wording must be "to the maximum extent permitted by law" and reviewed once
   before launch).
3. **Australian Privacy Act 1988 (APPs).** PII collected is minimal by design: an
   anonymous device identity (the auth uid, §5), optional email, submission
   timestamps + trail locations. Compliance posture:
   - *APP 1/5 — open + collection notice:* a privacy policy page and an in-app notice
     at first submission stating what is collected, why, that storage is in Australia
     (Supabase Sydney, Section 4), and the contact address.
   - *APP 3 — minimal collection:* no name, no phone, no account required; email only
     if the user opts in; observation locations are trail features, not user tracking.
     One deliberate mitigation: published data never includes device identifiers, and
     `observed_at` is published at day granularity so a fold can't be used to place a
     specific hiker at a specific tank at a specific hour.
   - *APP 11 — security:* RLS everywhere, service-role key only in CI secrets.
   - *APP 12/13 — access + correction/deletion:* a settings-screen "Delete my
     contributions and data" action (Edge Function), plus the same via email
     request. The flow is **anonymize-in-place, not row deletion** — the first
     draft's "delete device row, tombstone submissions" was both impossible and
     dangerous: submission rows FK the device row (so it could not be deleted
     as written), and deleting *approved* observations would make the next
     weekly fold silently flip published water statuses — a privacy request
     must never mutate safety data. Concretely: erase and unlink the email;
     hard-delete or tombstone only *unpublished* (queued/pending) rows; keep
     approved/published rows but sever their device link — `device_id` is
     nullable with `ON DELETE SET NULL` (§2.2), so deleting the `devices` row
     anonymizes everything it touched in one statement. Published aggregates
     are unaffected by design: they are CC0, already carry no device identifier
     (see APP 3), and the notice says so explicitly.
   - The project is almost certainly under the $3M small-business threshold, so much
     of the Act may not strictly apply — comply anyway; it is cheap at this scale and
     the residency choice was made for it.
4. **ToS + takedown.** A short ToS covering the CC0 grant, acceptable use, moderation
   rights, and disclaimer, accepted implicitly at first submission (link + "by
   submitting you agree"). Takedown process: any content can be reported via the 6a
   feedback email; target acknowledge within 72h; since all content is pre-moderated
   and text-only, takedown means rejecting/unpublishing a row and running the fold —
   minutes of work. Land-manager requests (e.g. a parks service asking to remove a
   sensitive site) are honored by default.
