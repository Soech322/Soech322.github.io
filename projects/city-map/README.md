# Places to pause

A filterable interactive city map with connected results, keyboard-friendly controls, and synthetic demonstration data.

**Project type:** self-initiated demonstration, created with AI assistance. Not paid client work.

**Skills:** Leaflet.js · JavaScript · GIS

## Problem and approach

Geographic points are easier to explore when a map and a searchable list stay connected. Category and text filters update both views, selecting a location opens details, and reset restores the full dataset. All six locations are synthetic samples near Temirtau, not verified city facilities.

## Run

From the repository root with Node.js 20+:

```sh
npm start
```

Open `http://127.0.0.1:4173/projects/city-map/`. No package installation or build step is required.

## Demo

[Open the interactive demo](https://Soech322.github.io/projects/city-map/)

## Limitations

Leaflet 1.9.4 loads from unpkg and base tiles from OpenStreetMap. The map needs internet access; the list works without map tiles. No location tracking or route calculation.

## What to demonstrate to a client

Search for “garden”, filter playgrounds, select a result, and reset the view.
