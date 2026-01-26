# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
npm install          # Install dependencies
npm run dev          # Start Vite dev server (port 5173)
npm run build        # Full production build (climate + trails + TS compile + Vite)
npm run build:trails # Build trail pages from data/trails/
npm run fetch:climate # Fetch climate data for trail locations
npm test             # Run all tests with Vitest
npm test -- --watch  # Watch mode
npm run lint         # Run ESLint
```

## Architecture Overview

**Trail Maps** is a TypeScript web application for displaying Australian long-distance hiking trails with interactive maps, elevation profiles, and waypoint data.

### Core Library (`src/lib/`)

Shared processing modules:
- `distance.ts` - Haversine distance calculations
- `gpx-optimizer.ts` - Track simplification (Douglas-Peucker)
- `track-classification.ts` - Classify main/alternate/side-trip tracks
- `waypoint-classifier.ts` - Classify waypoint types (town, hut, water, etc.)
- `types.ts` - TypeScript interfaces

### Build Scripts (`scripts/`)

- `build-trails.ts` - Generates static trail pages from GPX/JSON data
- `fetch-climate.ts` - Fetches historical climate data for trail locations

### Web UI (`src/web/`)

- `index.html` - Landing page with trail listing
- `trails/index.html` - Trail listing page
- `trails/trail-template.html` - Template for individual trail pages
- `trails/climate-template.html` - Template for climate data pages
- `trails/trail-viewer.ts` - Interactive trail viewer (map, elevation profile, waypoints)

### Trail Data (`data/trails/`)

Each trail has its own directory containing:
- `*.gpx` - Original GPX track data
- `trail.json` - Trail metadata and waypoints
- `climate.json` - Climate data for locations along the trail

### Generated Data (`public/data/generated/`)

Built at build time:
- `index.json` - Trail index
- `{trail-id}.json` - Processed trail data with simplified tracks

### Path Alias

`@lib` maps to `src/lib/` (configured in vite.config.ts and tsconfig.json).

## Key Patterns

- **Build-time processing**: Trail data is processed at build time into optimized JSON
- **Static site**: All pages are pre-generated, no runtime server required
- **Client-side rendering**: Trail viewer loads JSON data and renders interactively
- **Leaflet maps**: Uses OpenTopoMap tiles for topographic display

## Testing

Tests use Vitest with jsdom. Test files are colocated with source (`*.test.ts` in `src/lib/`).
