import test from "node:test";
import assert from "node:assert/strict";
import { quote } from "../projects/quote-calculator/core.mjs";
import { inspectGeoJSON } from "../projects/geojson-lab/core.mjs";
test("quote combines scope and applies priority to the whole subtotal", () => {
  assert.equal(
    quote({ pages: 3, form: true, map: true, maintenance: true, urgent: true })
      .total,
    425,
  );
  assert.equal(quote({ pages: 1 }).total, 120);
});
test("quote rejects invalid page counts", () => {
  for (const pages of [0, -1, 21, 1.5, NaN, Infinity])
    assert.throws(() => quote({ pages }), RangeError);
});
test("GeoJSON reads feature collections and bounds", () => {
  const r = inspectGeoJSON({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: [
            [10, 20],
            [30, 40],
          ],
        },
      },
    ],
  });
  assert.equal(r.valid, true);
  assert.deepEqual(r.bounds, [10, 20, 30, 40]);
  assert.equal(r.features, 1);
});
test("GeoJSON rejects bad coordinates, open rings, unknown types", () => {
  for (const geometry of [
    { type: "Point", coordinates: [181, 0] },
    { type: "Point", coordinates: ["x", 1] },
    {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [1, 1],
          [2, 2],
          [3, 3],
        ],
      ],
    },
    { type: "Nope", coordinates: [] },
  ])
    assert.equal(inspectGeoJSON(geometry).valid, false);
});
test("GeoJSON accepts null geometry, collections and all geometry families", () => {
  assert.equal(
    inspectGeoJSON({ type: "Feature", properties: null, geometry: null }).valid,
    true,
  );
  for (const geometry of [
    { type: "MultiPoint", coordinates: [[1, 2]] },
    {
      type: "MultiLineString",
      coordinates: [
        [
          [1, 2],
          [3, 4],
        ],
      ],
    },
    {
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      ],
    },
    {
      type: "GeometryCollection",
      geometries: [{ type: "Point", coordinates: [0, 0] }],
    },
  ])
    assert.equal(inspectGeoJSON(geometry).valid, true);
});
test("GeoJSON rejects malformed feature and missing fields", () => {
  assert.equal(
    inspectGeoJSON({
      type: "FeatureCollection",
      features: [{ type: "Point", coordinates: [0, 0] }],
    }).valid,
    false,
  );
  assert.equal(
    inspectGeoJSON({ type: "Feature", geometry: null }).valid,
    false,
  );
  assert.equal(
    inspectGeoJSON({ type: "Feature", properties: {} }).valid,
    false,
  );
});
