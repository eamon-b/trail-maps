# Part 7: Trip Sharing & Emergency Contacts (v2.0 - DEFERRED)

## Goal
Enable hikers to share their trip plans and progress with family/emergency contacts for safety and peace of mind.

---

## ⚠️ VERSION SCOPE: v2.0

**This part is explicitly deferred to v2.0.**

### Why Deferred
1. **Privacy complexity** - Location sharing requires careful design
2. **Liability concerns** - Overdue alerts could trigger false alarms
3. **Backend required** - Progress visibility needs server infrastructure
4. **Not core to v1.0 value** - The campsite planner works without this

### When to Implement
- After v1.0 launch and user feedback
- Can share backend infrastructure with Part 6 if both implemented
- Consider as focused v2.x enhancement

### v1.0 Alternative
For v1.0, users can:
- Export their day plan as PDF/text to share manually
- Use existing apps (WhatsApp, SMS) to share location
- No in-app trip sharing required

---

## Deliverables

### 1. Emergency Contact Management
- Add one or more emergency contacts
- Store contact information (name, phone, email)
- Designate primary contact
- Edit/remove contacts
- Privacy-focused: contacts stored locally by default

### 2. Trip Plan Logging
- Create formal trip plan from campsite planner data:
  - Start date and expected end date
  - Daily itinerary (campsites per day)
  - Expected checkpoints
  - Emergency contact information
  - Vehicle/trailhead information
- Save and edit trip plans
- Multiple plans per trail

### 3. Share Plan with Emergency Contact
- Generate shareable trip plan summary
- Share via:
  - Email
  - SMS/text message
  - Messaging apps (share sheet)
  - PDF export for printing
- Include:
  - Complete itinerary
  - Map overview
  - Key waypoints
  - Emergency numbers
  - Expected check-in dates

### 4. Progress Visibility for Contacts
- Optional: share progress link with emergency contacts
- When hiker has connectivity and sends update:
  - Contact can see last known position
  - Contact can see progress vs plan
  - Shows "last update X hours ago"
- Privacy controls (hiker explicitly sends updates)
- No automatic tracking without consent

### 5. "I'm Here" Manual Location Ping
*(Moved from Part 3 - fits naturally with trip sharing)*
- Button to manually send current location to emergency contacts
- Requires connectivity
- Generates shareable message with:
  - Current GPS coordinates
  - Current km position on trail
  - Map link
  - Timestamp
- Share via SMS, messaging apps, or email
- Privacy-conscious: user-initiated only, never automatic

### 6. Check-In Reminders
- Set expected check-in dates/times based on plan
- Reminder notification to send update when check-in is due
- Easy "I'm OK" message generation (pre-filled, one tap to send)
- "Running behind schedule" message option

### 7. Overdue Alerts (Opt-In Only)
**WARNING: High-risk feature. Default to OFF.**
- If check-in is missed by configurable time:
  - Notify emergency contact with last known location
  - Include instructions for contact on next steps
- **Safeguards:**
  - Requires explicit opt-in with clear explanation of implications
  - Generous grace periods (minimum 24 hours before alert)
  - Easy "I'm OK, just late" check-in to cancel pending alert
  - Clear setup wizard explaining what happens

### 8. "I Made It" Completion Message
- Easy end-of-trip message to emergency contacts
- Automatically generated summary:
  - Completed date
  - Total distance
  - Highlight moments (if journal entries exist)

### 9. Emergency Contact Experience
What the emergency contact sees (no app install required):
- Receives link to a simple web page
- Page shows:
  - Last known location on map
  - Progress vs plan (if plan was shared)
  - Last check-in time
  - Hiker's expected itinerary
- Page works on any device with a browser
- **Loads without JavaScript** (for contacts in areas with poor connectivity)
- Optional: contact can send encouragement message (displayed in hiker's app)

### 10. Privacy Design Principles
- Location shared **ONLY when user explicitly initiates** (tap to share)
- No persistent tracking (share point-in-time location, not continuous stream)
- Contact links expire after trip end date + 7 days
- User can revoke sharing at any time
- No location history retained on server after trip ends + 7 days
- All location data encrypted in transit

## Success Criteria
- Can create and share trip plan with emergency contact
- Emergency contacts receive readable, useful plan summary
- Progress updates work when connectivity available
- Check-in reminders appear on schedule
- Privacy is preserved (no unwanted tracking)
- Sharing workflow completable in < 2 minutes
- Contact page loads without JavaScript
- Zero false positive overdue alerts in testing
- No server-side location retention beyond trip + 7 days

## Dependencies
- Part 0: Foundation & Project Setup
- Part 3: Planning Tools (campsite planner data)
- Part 5: On-Trail Features (location, journal)
- Part 6: Community Features (backend for progress sharing - optional)

## Notes
- **Deferred to v2.0** - not required for core app functionality
- Basic sharing (export plan as PDF) could be added to v1.0 as a lightweight feature without backend
- Progress visibility requires backend infrastructure (could share with Part 6)
- Focus on hiker safety without being intrusive
- Consider integration with emergency services contacts (e.g., police non-emergency numbers for trail regions)
- Australian context: consider integration with trip intention systems used by parks services

---

## Review Notes

**Reviewed: 2026-02-05**

### Checklist Assessment
- [x] Marked as optional (appropriate)
- [x] Dependencies correctly identified
- [ ] Privacy implications need expansion
- [ ] Technical implementation underspecified

### Assessment: Good Optional Enhancement

This part is appropriately scoped as optional. It adds meaningful safety value without being required for core functionality. The phased approach is sensible.

### Issues Found

1. **Overdue alerts (Section 6) are high-risk**
   False positive overdue alerts could:
   - Cause unnecessary worry/panic for contacts
   - Lead to unnecessary rescue calls
   - Damage user trust

   **Recommendations:**
   - Default to OFF (opt-in only)
   - Generous grace periods (e.g., 24+ hours)
   - Multiple confirmation channels before alerting emergency contact
   - Clear setup wizard explaining implications
   - Test extensively before enabling

2. **Progress visibility backend dependency**
   Sections 4-6 require backend. Two approaches:

   **A) Share Part 6 backend:**
   - Pro: Less infrastructure to maintain
   - Con: Ties optional feature to major scope increase

   **B) Minimal dedicated backend:**
   - Simple key-value store for location/status
   - No user accounts needed (use device ID + share token)
   - Could be serverless (Cloudflare Workers, Lambda)

   **Recommendation:** Option B for faster implementation if Part 6 is delayed.

3. **"I'm Here" functionality moved here correctly**
   The review of Part 3 suggested moving "I'm Here" ping here. This is the right place. It naturally fits with:
   - Check-in reminders
   - Progress visibility
   - Emergency contact communication

4. **Missing: What contacts actually receive**
   The plan describes what the hiker does but not the contact experience:
   - Web page? SMS? Email?
   - How do they view progress?
   - Can they respond/communicate back?

   **Add section:**
   ```
   ### 8. Emergency Contact Experience
   - Contact receives link to web page (no app install required)
   - Page shows: last known location, progress vs plan, last check-in time
   - Optional: contact can send encouragement messages (displayed in app)
   - Page works on any device with a browser
   ```

5. **Australian parks integration is aspirational**
   The note mentions integration with parks services trip intention systems. Research needed:
   - Do Australian parks have APIs for this?
   - Manual submission to parks.vic.gov.au, etc.?
   - Format requirements?

   **Recommendation:** Start with manual "print your plan" for parks registration, API integration only if clear path exists.

### Privacy Considerations

This feature inherently involves sharing location. Add explicit privacy design:

```
### Privacy Design Principles
- Location shared ONLY when user explicitly initiates
- No persistent tracking (share point-in-time location, not continuous)
- Contact links expire after trip end date + grace period
- User can revoke sharing at any time
- No location history retained on server after trip ends
```

### Success Criteria Additions
- Sharing workflow completable in < 2 minutes
- Contact page loads without JavaScript (for remote/satellite areas)
- Zero false positive overdue alerts in testing
- Privacy: no server-side location retention beyond trip + 7 days
