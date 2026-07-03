# Part 6: Community Features (v2.0 - DEFERRED)

## Goal
Add crowdsourced updates and community interaction features, enabling users to contribute trail conditions, waypoint updates, comments, and photos. This is a significant architecture shift requiring backend infrastructure.

---

## ⚠️ VERSION SCOPE: v2.0

**This part is explicitly deferred to v2.0.** The app delivers significant value without community features.

### Why Deferred
1. **Backend infrastructure required** - Significant operational overhead
2. **Moderation burden** - Need processes before user base exists
3. **Scope risk** - Can delay v1.0 launch indefinitely
4. **Not differentiating for v1.0** - The campsite planner is the killer feature, not community

### When to Implement
- After v1.0 launch and initial user feedback
- When there's demonstrated demand for crowdsourced updates
- When resources exist for backend maintenance and moderation

### v1.0 Alternative
For v1.0, users can report issues via:
- In-app feedback form that generates an email
- GitHub issues for the project
- No backend required

---

## Phased Implementation

This part should be implemented in phases to manage complexity:

### Phase 6a: Feedback Without Backend (Launch with MVP)
- In-app feedback form → emails to maintainer
- Pre-filled with current location, trail, timestamp
- No user accounts needed
- Simple "Report an issue" button

### Phase 6b: Simple Backend (Post-launch, based on demand)
- User accounts (auth only)
- Trail condition reports (moderated)
- Basic comment system
- No photos yet

### Phase 6c: Full Community (Based on user demand)
- Full deliverables below

### Phase-to-Deliverable Mapping

When splitting into subpart files, deliverables map to phases as follows:

| Deliverable | 6a | 6b | 6c |
|---|---|---|---|
| 1. Backend Infrastructure | | Foundation (auth, DB, API) | Storage, realtime |
| 2. User Accounts | | Sign up/in, basic profile | Contribution stats, privacy settings |
| 3. Trail Condition Reports | | Basic reports (text only, moderated) | Photos, map overlays, severity levels |
| 4. Waypoint Updates | | | Full scope |
| 5. Comments on Waypoints | | Basic comments | Helpfulness sorting, flagging |
| 6. Photo Contributions | | | Full scope |
| 7. Campsite Ratings | | | Full scope |
| 8. Moderation System | | Basic approve/reject queue | Trusted users, audit trail, appeals |
| 9. Offline Sync | | | Full scope |
| 10. Contribute Mode UI | Feedback form only | Basic submission UI | Full two-tab UI with map overlays |

---

## Deliverables (Full Phase 6c)

### 1. Backend Infrastructure
**Backend technology decision:**

| Criteria | Supabase (Recommended) | Firebase | Custom |
|----------|------------------------|----------|--------|
| Auth built-in | ✓ | ✓ | Build |
| Realtime updates | ✓ | ✓ | Build |
| File storage | ✓ | ✓ | Build |
| Cost at scale | $$ | $$$ | $ |
| Vendor lock-in | Medium | High | None |
| Australian data residency | Via AWS Sydney | Limited | Full control |

**Recommendation:** Supabase for faster development, or custom if data residency is critical.

Set up:
- User authentication (email, social login options)
- Database for community contributions
- API endpoints for submissions
- Storage for user-uploaded photos

### 2. User Accounts
- Sign up / Sign in flow
- Profile management
- View your contributions
- Contribution history and stats
- Privacy settings
- Optional: anonymous contributions (with moderation)

### 3. Trail Condition Reports
- Report current trail conditions:
  - Closures (fire, flood, maintenance)
  - Hazards (fallen trees, washouts, wildlife)
  - General conditions (muddy, overgrown, clear)
- Location-specific reports tied to trail position
- Date/time stamped
- Optional photo attachment
- Severity/urgency level
- View conditions on map (icons/overlays)
- Filter by recency

### 4. Waypoint Updates
- Submit corrections to waypoint data:
  - Position corrections
  - Name/description updates
  - Type reclassification
- Add new waypoints
- Report waypoints as no longer valid
- Water source status updates (dry/flowing/seasonal)
- All submissions go to moderation queue

### 5. Comments on Waypoints
- Add comments to any waypoint
- View comments from other users
- Useful for:
  - Tips ("campsite is 50m off trail to the left")
  - Reviews ("beautiful views at sunset")
  - Warnings ("lots of mosquitoes in summer")
- Sort by date, helpfulness
- Flag inappropriate comments

### 6. Photo Contributions
- Upload photos tied to waypoints or trail positions
- Optional captions
- Photos visible to all users
- Photo gallery per waypoint
- Moderation for inappropriate content

### 7. Campsite Ratings
- Rate campsites (1-5 stars or similar)
- Aggregate ratings visible to all users
- Optional review text
- Helpful for planning

### 8. Moderation System
- Moderation queue for all submissions
- Approve/reject/edit workflow
- Flag system for users to report issues
- Trusted user system (reduced moderation for active contributors)
- Audit trail (who changed what, when)
- Conflict resolution for contradicting reports

**Moderation workflow:**
```
Submission → Auto-spam check → Moderation queue → Review → Publish/Reject
                                      ↓
                              Trusted users bypass queue
```

**Operational considerations:**
- Target: <24 hour review time for condition reports
- Escalation path for disputes
- Appeals process for rejected submissions
- Moderation dashboard with metrics

### 9. Offline Sync
- Queue submissions while offline
- Background Sync API integration
- Sync when connectivity returns
- Conflict resolution for edits made offline by multiple users

### 10. Contribute Mode UI
Two tabs in Contribute mode:
- **Notes**: Your pending submissions, drafts
- **Upload**: Submit new condition report, waypoint update, photo

View community data:
- Trail conditions overlay on map
- Comments in waypoint detail sheets
- Photos in galleries

## Success Criteria
- Users can create accounts and sign in
- Trail condition reports appear on map for all users
- Waypoint corrections flow through moderation and update data
- Comments appear on waypoint detail views
- Offline submissions sync when connected
- Moderation queue works for reviewing submissions

## Dependencies
- Part 0: Foundation & Project Setup
- Part 1: Design System & UX Foundation
- Part 2: Offline Trail Viewer
- Part 5: On-Trail Features (photo waypoints as contribution source)

## Notes
- This is the largest scope change - introduces backend, auth, moderation
- Data quality and spam prevention are real challenges
- Privacy considerations for user data and locations

## Legal Considerations
Before launching community features:
- **Terms of Service**: Required for user-generated content
- **Content licensing**: Define who owns submitted photos (recommend: user retains ownership, grants license to display)
- **Liability disclaimer**: Incorrect trail info could contribute to hiker harm
- **GDPR compliance**: User data deletion requests (right to be forgotten)
- **Australian Privacy Act**: If collecting personal information from Australian users

---

## Review Notes

**Reviewed: 2026-02-05**

### Checklist Assessment
- [x] Complexity accurately described
- [x] Phased approach suggested
- [ ] Backend technology decision incomplete
- [ ] Moderation workflow underspecified
- [ ] Legal/compliance considerations need expansion

### Critical Assessment: Should This Be Part of MVP?

**No.** This part is correctly identified as a major scope increase. Recommend:

1. **MVP (Parts 0-3)**: No community features
2. **v1.1 (Parts 4-5)**: Custom trails + on-trail features
3. **v2.0 (Part 6)**: Community features

The app delivers significant value without community features. Adding them too early risks:
- Delayed launch
- Backend maintenance burden
- Moderation overhead before there's a user base

### Issues Found

1. **Backend technology decision is critical and underspecified**
   The plan lists options (Supabase, Firebase, custom) but doesn't provide decision criteria.

   **Add decision framework:**
   | Criteria | Supabase | Firebase | Custom |
   |----------|----------|----------|--------|
   | Auth built-in | ✓ | ✓ | Build |
   | Realtime updates | ✓ | ✓ | Build |
   | File storage | ✓ | ✓ | Build |
   | Cost at scale | $$ | $$$ | $ |
   | Vendor lock-in | Medium | High | None |
   | Australian data residency | Via AWS Sydney | Limited | Full control |

   **Recommendation:** Supabase for faster development, or custom if data residency is critical.

2. **Moderation system is undersized**
   Moderation is often the hardest part of community features. Consider:
   - Who moderates? (Volunteer? Paid? You personally?)
   - What's the expected volume of submissions?
   - How quickly must submissions be reviewed?
   - What's the appeals process?

   **At minimum, add:**
   - Explicit moderation workflow diagram
   - Expected response time SLA
   - Escalation path for disputes

3. **Offline sync conflict resolution is complex**
   Section 9 mentions conflict resolution briefly. This needs detailed design:
   - Last-write-wins? (Simple but can lose data)
   - Manual merge? (Better but UX challenge)
   - Operational transforms? (Complex, overkill)

   **Recommendation:** For v1, use last-write-wins with "your submission was updated by another user" notification.

4. **Legal considerations missing**
   - Terms of service for user-generated content
   - Content licensing (who owns submitted photos?)
   - Liability for incorrect trail information
   - User data deletion requests (GDPR right to be forgotten)

### Suggested Phased Implementation

**Phase 6a: Feedback without backend**
- In-app feedback form → emails to maintainer
- Pre-filled with current location, trail, timestamp
- No user accounts needed
- Launch ASAP after MVP

**Phase 6b: Simple backend (3-6 months post-launch)**
- User accounts (auth only)
- Trail condition reports (moderated)
- Basic comment system
- No photos yet

**Phase 6c: Full community (based on user demand)**
- Photos
- Waypoint corrections
- Ratings
- Trusted users

### Risks

1. **Spam/abuse**: Even a small app will attract spam bots. Plan for this from day one.
2. **Liability**: Incorrect trail info could contribute to hiker harm. Consider disclaimers.
3. **Moderation burnout**: If you're the sole moderator, this can become overwhelming.

### Success Criteria Revisions

Current criteria are too vague. Add:
- Submission-to-published latency target (e.g., <24 hours for condition reports)
- Spam detection rate target (e.g., <1% spam reaches users)
- Uptime SLA for backend services
