# TODO

## Bugs and small fixes

- blue bits on the map

- testing files
- change the name from trail-companion — app is now Tracknotes (`com.tracknotes.app`); root `package.json` is still `trail-maps`
- remove the warning for long food or water carries
- water carry info relies on good waypoints.
  - add ability to add a custom waypoint, where you know that there is water?

- upload all the grid tiles later - at public/data/tiles/grid
    - will cost something like 20c/month to host

- fix wierd blue bits when more zoomed in

## Bigger ideas

- efficiency

quality control on the waypoints and GPX
    - simple things like spelling
    - hard things like 'does it still exist'

other trails to add:

ask about using theadventuregene's GPX files for this

add a brief description of where the GPX data is from (with link if using one someone else made)

check that all the recently added features work

## Very Big changes

The offline mobile app shipped (Tracknotes): map, elevation profile, waypoint list/datasheet,
offline tiles, distance + gain from location to upcoming points, day splits / resupply / water
carry planning, and comments. The web planner shipped too. What's still missing from the
original idea:

    - ability to add your own GPX files with waypoints, make the datasheet (functionality already exists as a standalone tool, it is now in a different repo `gpx-tools`), and create the pages to see your trail in the app pages
    - ability to crowd source - add new points, remove old points, update descriptions
    - measure distance etc between two points
    - select campsites for next few days, automatically make stats for each day. Able to edit and move points one at a time and auto update stats (web planner only; mobile auto-splits)

    - need very strong UX
    - need very strong reliability. No gaps or missing points, considerations overlooked

ask for feedback about what people want from a trail nav app - what is missing from current options, what I see as missing
    - ability to add your own GPX files
    - ability to crowd source - add new points, remove old points, update descriptions, add comments
    - free and accessible
what is the end goal? a catalogue of hiking trails in aus with (somewhat) curated (maybe by users) trails?
