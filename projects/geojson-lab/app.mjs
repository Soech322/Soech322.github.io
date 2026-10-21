import { inspectGeoJSON } from "./core.mjs";
const source = document.querySelector("#source"),
  report = document.querySelector("#report"),
  plot = document.querySelector("#plot"),
  download = document.querySelector("#download");
let validData = null;
const sample = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { name: "Sample point" },
      geometry: { type: "Point", coordinates: [72.96, 50.06] },
    },
    {
      type: "Feature",
      properties: { name: "Sample route" },
      geometry: {
        type: "LineString",
        coordinates: [
          [72.95, 50.05],
          [72.96, 50.06],
          [72.98, 50.065],
        ],
      },
    },
    {
      type: "Feature",
      properties: { name: "Sample area" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [72.94, 50.05],
            [72.95, 50.05],
            [72.95, 50.06],
            [72.94, 50.05],
          ],
        ],
      },
    },
  ],
};
function invalid(message) {
  validData = null;
  download.disabled = true;
  report.className = "result error";
  report.textContent = message;
  plot.replaceChildren();
}
function inspect() {
  validData = null;
  download.disabled = true;
  plot.replaceChildren();
  if (new Blob([source.value]).size > 2 * 1024 * 1024) {
    invalid("Input exceeds the 2 MB limit.");
    return;
  }
  try {
    const data = JSON.parse(source.value);
    const result = inspectGeoJSON(data);
    if (!result.valid) {
      invalid(
        result.errors.slice(0, 30).join("\n") +
          (result.errors.length > 30 ? "\nMore errors omitted." : ""),
      );
      return;
    }
    validData = data;
    download.disabled = false;
    report.className = "result";
    report.textContent =
      "Basic structural checks passed.\nFeatures: " +
      result.features +
      "\nGeometry counts: " +
      JSON.stringify(result.types) +
      "\nPositions: " +
      result.positions.length +
      "\nBounds [west, south, east, north]: " +
      (result.bounds
        ? result.bounds.map((n) => n.toFixed(5)).join(", ")
        : "No coordinates");
    if (result.bounds) {
      const [west, south, east, north] = result.bounds;
      const width = east - west || 0.001,
        height = north - south || 0.001;
      const scale = Math.min(440 / width, 190 / height);
      result.positions.slice(0, 2000).forEach((p) => {
        const circle = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "circle",
        );
        circle.setAttribute("cx", 250 + (p[0] - (west + east) / 2) * scale);
        circle.setAttribute("cy", 125 - (p[1] - (south + north) / 2) * scale);
        circle.setAttribute("r", "4");
        plot.append(circle);
      });
    }
  } catch (error) {
    invalid(
      error instanceof SyntaxError
        ? "Invalid JSON: " + error.message
        : "Unable to inspect this input: " + error.message,
    );
  }
}
function load() {
  source.value = JSON.stringify(sample, null, 2);
  inspect();
}
document.querySelector("#sample").addEventListener("click", load);
document.querySelector("#validate").addEventListener("click", inspect);
source.addEventListener("input", () => {
  invalid("Input changed. Select Inspect data to check this version.");
});
document.querySelector("#file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    source.value = "";
    invalid("File exceeds the 2 MB limit.");
    return;
  }
  try {
    source.value = await file.text();
    inspect();
  } catch {
    invalid("The file could not be read.");
  }
});
download.addEventListener("click", () => {
  if (!validData) return;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(validData, null, 2)], {
      type: "application/geo+json",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "inspected.geojson";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
load();
