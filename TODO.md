# TODO

## Bugs and small fixes

- blue bits on the map
- no contours on online maps
- still snapping back to selected point, after dismissing the info and trying to move away. Have attempted to fix this bu not luck
- show on elevation profile does nothing

fix datasheet offset on variants
- improved now, but not quite what I wanted.

- testing files
- setup maestro completely
- change the name from trail-companion
- posttooluse hook on write as well as edit
- check zoom level 15 works
- remove the warning for long food or water carries
- water carry info relies on good waypoints.
  - add ability to add a custom waypoint, where you know that there is water?

- upload all the grid tiles later - at public/data/tiles/grid
    - will cost something like 20c/month to host

- make contours stronger, especially more zoomed out
- fix wierd blue bits when more zoomed in

bugs:
- "show on elevation profile" button doesn't work
  - still doesn't work

## Bigger ideas

- efficiency

- add planning pages from the app to the webapp. This would make it great and even better, since there is much more screen space on a computer.

quality control on the waypoints and GPX
    - simple things like spelling
    - hard things like 'does it still exist'

other trails to add:

ask about using theadventuregene's GPX files for this

add a brief description of where the GPX data is from (with link if using one someone else made)

check that all the recently added features work

## Very Big changes

make trails available offline, with a mobile app

most important is a great map, elevation profile and datasheet presentation in the app. Intuitive and easy to use and functional.

trail app? similar to farout, with current location, distances and elevation to next points. works with existing trails and data+maps. BUT also the ability to upload your own GPX with waypoints, make the datasheet (functionality already exists as a standalone tool, it is now in a different repo `gpx-tools`), and create the pages to see your trail in the app pages (like where you are, how far to upcoming points, etc). Basically my own extensible (very important) version of other trail app. UX is very important in this case. Clarity and ability to switch between different views/pages and see the important information is critial (others can be a little difficult to use in this case, it's not quite clear what views are available and how to switch between them).
    - need very strong UX
    - need very strong reliability. No gaps or missing points, considerations overlooked

important features:
    - distance and gain from location to selected point
    - measure distance etc between two points
    - select campsites for next few days, automatically make stats for each day. Able to edit and move points one at a time and auto update stats
    - ability to add your own GPX files
    - ability to crowd source - add new points, remove old points, update descriptions, add comments
    - free and accessible

other pages that would be useful
- resupply planning page/tool (for web app as well) some work is required to figure out what this should look like
- water carry distances

ask for feedback about what people want from a trail nav app - what is missing from current options, what I see as missing
    - ability to add your own GPX files
    - ability to crowd source - add new points, remove old points, update descriptions, add comments
    - free and accessible
what is the end goal? a catalogue of hiking trails in aus with (somewhat) curated (maybe by users) trails?
