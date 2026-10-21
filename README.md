# Vladimir Borodkin — Web Development Portfolio

Five practical demonstrations covering HTML, responsive web development, JavaScript, Leaflet.js, GeoJSON, and Python maintenance tooling.

[Live portfolio](https://Soech322.github.io/) · [LinkedIn](https://www.linkedin.com/in/vladimir-borodkin-65a210445/)

## Projects

| Project | Skills | Demo | Source and notes |
|---|---|---|---|
| Fieldwork | HTML · CSS · Web development | [Open](https://Soech322.github.io/projects/business-site/) | [README](projects/business-site/README.md) |
| Scope & price | JavaScript · DOM · Forms | [Open](https://Soech322.github.io/projects/quote-calculator/) | [README](projects/quote-calculator/README.md) |
| Places to pause | Leaflet.js · JavaScript · GIS | [Open](https://Soech322.github.io/projects/city-map/) | [README](projects/city-map/README.md) |
| GeoJSON Lab | GeoJSON · JavaScript · GIS | [Open](https://Soech322.github.io/projects/geojson-lab/) | [README](projects/geojson-lab/README.md) |
| Link Check | Python · Maintenance · Technical support | [Open](https://Soech322.github.io/projects/link-checker/) | [README](projects/link-checker/README.md) |

## Run locally

Node.js 20+ is enough; no npm dependencies or build step.

~~~sh
npm start
~~~

Open http://127.0.0.1:4173.

## Check the code

~~~sh
npm test
cd projects/link-checker
python -m unittest -v
~~~

Python 3.10+ is required for the crawler tests.

## Attribution and scope

These are self-initiated demonstration projects created with AI assistance. They are not presented as paid client work. The fictional business and map locations are clearly marked as samples. This repository is separate from the team playground-mapping project mentioned in my professional profile.

Leaflet 1.9.4 is loaded from unpkg under its BSD-2-Clause license. Base map tiles are supplied by OpenStreetMap with attribution. Google Fonts supplies DM Sans and Space Grotesk; system fonts are used as fallbacks.

## Publish on GitHub Pages

Repository: Soech322.github.io. In Settings → Pages, select **Deploy from a branch**, **main**, and **/(root)**. No secrets or server are needed. Python runs locally; its project page is a static explanation.

## Work with me

For website fixes, landing pages, or interactive map features, [send a LinkedIn message](https://www.linkedin.com/in/vladimir-borodkin-65a210445/) with the website, task, and preferred deadline. Scope and pricing are agreed before work starts.
