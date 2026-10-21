# GeoJSON Lab

A browser-local geodata inspector with structural validation, coordinate checks, bounds, and an SVG preview.

**Project type:** self-initiated demonstration, created with AI assistance. Not paid client work.

**Skills:** GeoJSON · JavaScript · GIS

## Problem and approach

Before displaying geodata, inspect its structure and coordinates. The tool accepts geometries, Features and FeatureCollections, reports basic structural errors, calculates bounds, plots up to 2,000 vertices, and exports formatted JSON. Data remains in the browser.

## Run

From the repository root with Node.js 20+:

```sh
npm start
```

Open `http://127.0.0.1:4173/projects/geojson-lab/`. No package installation or build step is required.

## Demo

[Open the interactive demo](https://Soech322.github.io/projects/geojson-lab/)

## Limitations

2 MB input limit. Basic structural checks only: not a full RFC 7946 validator; no topology, polygon winding, CRS conversion, or self-intersection validation. SVG preview shows vertices rather than a basemap.

## What to demonstrate to a client

Load the sample, change a latitude to 120 to see an error, then restore it and export.
