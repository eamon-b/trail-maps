---
Step 16: Download SRTM DEM tiles

Bibbulmun is already covered (20 tiles in data/dem/). You need 34 more tiles for the other 5 trails.

Go to the ELVIS portal

URL: https://elevation.fsdf.org.au/

For each region below, draw a bounding box on the map, select "1 Second SRTM DEM-S", and submit. You'll get an email with a download link (usually
within minutes).

Download 1: Western Australia — Cape to Cape (2 tiles)

Draw a box around: lat -35.5 to -33.5, lon 114.5 to 115.5

Missing tiles: S34E114, S35E114

Download 2: Northern Territory — Larapinta (2 tiles)

Draw a box around: lat -24.5 to -23, lon 132 to 134.5

Missing tiles: S24E132, S24E133

Download 3: South Australia — Heysen (15 tiles)

Draw a box around: lat -36.5 to -31, lon 137.5 to 139.5

Missing tiles:
S32E137  S32E138  S32E139
S33E137  S33E138  S33E139
S34E137  S34E138  S34E139
S35E137  S35E138  S35E139
S36E137  S36E138  S36E139

Download 4: NSW/Victoria — AAWT + Hume & Hovell (17 tiles, shared region)

Draw a box around: lat -38.5 to -34.5, lon 146 to 149.5

Missing tiles:
S35E146  S35E147  S35E148
S36E146  S36E147  S36E148  S36E149
S37E146  S37E147  S37E148  S37E149
S38E146  S38E147  S38E148  S38E149

After downloading

Unzip all files and place the .hgt (or .tif) files into data/dem/. The build script reads all DEM files from that directory automatically — no
per-trail configuration needed.

---
Step 17: Run the pipeline for all 6 trails

You need a Protomaps source. Two options:

Option A — Remote extraction (no 120GB download):
npm run build:tiles -- --protomaps-url https://build.protomaps.com/20260101.pmtiles
Replace the date with the https://maps.protomaps.com/builds/. This extracts only the corridor regions over HTTP.

Option B — Single trail at a time:
npm run build:tiles -- --trail cape_to_cape --protomaps-url https://build.protomaps.com/20260101.pmtiles
npm run build:tiles -- --trail larapinta --protomaps-url https://build.protomaps.com/20260101.pmtiles
npm run build:tiles -- --trail heysen --protomaps-url https://build.protomaps.com/20260101.pmtiles
npm run build:tiles -- --trail aawt --protomaps-url https://build.protomaps.com/20260101.pmtiles
npm run build:tiles -- --trail hume-and-hovell --protomaps-url https://build.protomaps.com/20260101.pmtiles

Output goes to public/data/tiles/{trail-id}/ with base.mbtiles, contours.mbtiles, and manifest.json per trail.

## Upload to cloudflare R2

What you need to do next (manual steps)

private: https://02d2391a8994960e800c486af7739ccf.r2.cloudflarestorage.com/aus-map-data
public: https://pub-2c4c91b48919451cb92108f6171071d6.r2.dev

1. Create a Cloudflare account and R2 bucket named trail-companion-tiles
2. Enable public access on the bucket
3. Optionally add a custom domain (e.g. tiles.trailcompanion.app)
4. npm install -g wrangler && wrangler login
5. After building tiles: npm run upload:tiles
6. Set EXPO_PUBLIC_TILE_BASE_URL in your mobile .env to the public URL
