// main.js (ES module)

// If you are using Cesium as a global (from Build/Cesium/Cesium.js),
// it is available as window.Cesium.
const Cesium = window.Cesium;

// ------------------------------------------------------------
// Viewer (NO default imagery)
// ------------------------------------------------------------
const viewer = new Cesium.Viewer("cesiumContainer", {
  animation: false,
  timeline: false,
  baseLayerPicker: false,
  sceneModePicker: true,
  geocoder: true,
  imageryProvider: false,
  terrainProvider: new Cesium.EllipsoidTerrainProvider(),
});

viewer.scene.globe.enableLighting = true;

// ------------------------------------------------------------
// Add Bing Aerial imagery from Cesium ion
// assetId 2 is the standard Bing Aerial base layer in ion
// ------------------------------------------------------------
viewer.imageryLayers.addImageryProvider(
  new Cesium.IonImageryProvider({
    assetId: 2,
  })
);

// =============================================================
// LOAD SITES FROM EXCEL (sites.xlsx)
// - Sheet: "Population" (falls back to first sheet)
// - Column "Coordinates" is "lat, lon" in your file
// - Dedupe using "Customer ID" when possible
// =============================================================
async function loadSitesFromExcel() {
  const url = "sites.xlsx"; // put this in repo root next to index.html

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);

  const buf = await res.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });

  const sheet =
    wb.Sheets["Population"] || wb.Sheets[wb.SheetNames[0]];

  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  const byKey = new Map();

  for (const r of rows) {
    const coordStr = String(r["Coordinates"] ?? "").trim();
    if (!coordStr) continue;

    // Coordinates in your sheet look like: "0.360129..., 32.581690..."
    // That is LAT, LON. Cesium wants LON, LAT.
    const parts = coordStr.split(",").map((s) => s.trim());
    if (parts.length < 2) continue;

    const lat = Number(parts[0]);
    const lon = Number(parts[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const customerId = String(r["Customer ID"] ?? "").trim();
    const name =
      String(r["Customer Name"] ?? "").trim() ||
      String(r["Customer"] ?? "").trim() ||
      `Site`;

    // Dedupe key: prefer Customer ID, else fallback to coordinate string
    const key = customerId || coordStr;

    if (!byKey.has(key)) {
      byKey.set(key, {
        id: customerId,
        name,
        lon,
        lat,
      });
    }
  }

  const sites = [...byKey.values()];

  if (sites.length === 0) {
    throw new Error(
      "No sites loaded. Check Excel sheet name and 'Coordinates' column."
    );
  }

  return sites;
}

// =============================================================
// CREATE DOTS
// =============================================================
function addSitesToMap(siteObjs) {
  const entities = [];

  siteObjs.forEach((s, i) => {
    const e = viewer.entities.add({
      name: s.name ? `${s.name}` : `Site ${i + 1}`,
      position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat),
      point: {
        pixelSize: 10,
        color: Cesium.Color.YELLOW,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      description: `
        <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;">
          <div style="font-weight:600; margin-bottom:6px;">${escapeHtml(
            s.name || `Site ${i + 1}`
          )}</div>
          <div><b>Lat:</b> ${s.lat}</div>
          <div><b>Lon:</b> ${s.lon}</div>
          ${s.id ? `<div><b>ID:</b> ${escapeHtml(s.id)}</div>` : ""}
        </div>
      `,
    });

    entities.push(e);
  });

  return entities;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// =============================================================
// KNOBS YOU CARE ABOUT
// =============================================================

// Camera distances
const overviewRangeMeters = 13500000; // far OUT between sites
const siteRangeMeters = 1200;         // close IN at the site

// Travel behavior
const travelSeconds = 2.5;            // move above site + zoom out duration
const zoomInSeconds = 2.5;            // zoom down duration
const tiltSeconds = 1.6;              // tilt duration

// Orbit behavior (ONLY while holding at the site)
const orbitPitchDeg = -45;
const orbitSpeedDegPerSec = 8;
const holdSeconds = 3;

// Flat travel orientation (north-up, no rotation)
const flatHeadingDeg = 0;
const flatPitchDeg = -90;

// Auto tour
let autoAdvance = true;

// =============================================================
// INTERNAL STATE
// =============================================================
let entities = [];
let activeIndex = 0;
let orbit = false; // orbit starts OFF (travel flat)
let headingDeg = 0;
let lastPerf = performance.now();
let isFlying = false;

// =============================================================
// HELPERS
// =============================================================
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getActiveSitePosition() {
  return entities[activeIndex].position.getValue(Cesium.JulianDate.now());
}

function flyToRange({ rangeMeters, pitchDeg, headingDegValue, durationSec }) {
  const target = getActiveSitePosition();
  const offset = new Cesium.HeadingPitchRange(
    Cesium.Math.toRadians(headingDegValue),
    Cesium.Math.toRadians(pitchDeg),
    rangeMeters
  );

  isFlying = true;

  return new Promise((resolve) => {
    viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(target, 1.0), {
      duration: durationSec,
      offset,
      complete: () => {
        isFlying = false;
        lastPerf = performance.now();
        resolve(true);
      },
      cancel: () => {
        isFlying = false;
        lastPerf = performance.now();
        resolve(false);
      },
    });
  });
}

async function goAboveSiteFlat() {
  orbit = false;
  headingDeg = 0;
  await flyToRange({
    rangeMeters: overviewRangeMeters,
    pitchDeg: flatPitchDeg,
    headingDegValue: flatHeadingDeg,
    durationSec: travelSeconds,
  });
}

async function zoomDownFlat() {
  orbit = false;
  headingDeg = 0;
  await flyToRange({
    rangeMeters: siteRangeMeters,
    pitchDeg: flatPitchDeg,
    headingDegValue: flatHeadingDeg,
    durationSec: zoomInSeconds,
  });
}

async function tiltIntoOrbitPitch() {
  orbit = false;
  headingDeg = 0;
  await flyToRange({
    rangeMeters: siteRangeMeters,
    pitchDeg: orbitPitchDeg,
    headingDegValue: 0,
    durationSec: tiltSeconds,
  });
}

async function tiltBackToFlat() {
  orbit = false;
  headingDeg = 0;
  await flyToRange({
    rangeMeters: siteRangeMeters,
    pitchDeg: flatPitchDeg,
    headingDegValue: flatHeadingDeg,
    durationSec: tiltSeconds,
  });
}

// =============================================================
// ORBIT LOOP (ONLY active when orbit === true)
// =============================================================
viewer.clock.onTick.addEventListener(() => {
  if (!orbit) return;
  if (isFlying) return;

  const now = performance.now();
  const dt = Math.min((now - lastPerf) / 1000, 0.05);
  lastPerf = now;

  headingDeg += orbitSpeedDegPerSec * dt;

  viewer.camera.lookAt(
    getActiveSitePosition(),
    new Cesium.HeadingPitchRange(
      Cesium.Math.toRadians(headingDeg),
      Cesium.Math.toRadians(orbitPitchDeg),
      siteRangeMeters
    )
  );
});

// =============================================================
// TOUR
// =============================================================
async function runTour() {
  while (autoAdvance) {
    await goAboveSiteFlat();
    if (!autoAdvance) break;

    await zoomDownFlat();
    if (!autoAdvance) break;

    await tiltIntoOrbitPitch();
    if (!autoAdvance) break;

    headingDeg = 0;
    orbit = true;
    await sleep(holdSeconds * 1000);

    orbit = false;
    await tiltBackToFlat();
    if (!autoAdvance) break;

    await goAboveSiteFlat();
    if (!autoAdvance) break;

    activeIndex = (activeIndex + 1) % entities.length;
  }
}

// =============================================================
// CONTROLS
// =============================================================
const canvas = viewer.scene.canvas;
canvas.setAttribute("tabindex", "0");
canvas.focus();

canvas.addEventListener("mousedown", () => {
  autoAdvance = false;
  orbit = false;
  viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
});

canvas.addEventListener("keydown", async (e) => {
  const k = e.key.toLowerCase();

  if (k === "r") {
    autoAdvance = false;
    orbit = false;
    await zoomDownFlat();
    await tiltIntoOrbitPitch();
    headingDeg = 0;
    orbit = true;
    e.preventDefault();
  }

  if (k === "n") {
    autoAdvance = false;
    orbit = false;
    activeIndex = (activeIndex + 1) % entities.length;
    await goAboveSiteFlat();
    await zoomDownFlat();
    e.preventDefault();
  }

  if (k === "p") {
    autoAdvance = false;
    orbit = false;
    activeIndex = (activeIndex - 1 + entities.length) % entities.length;
    await goAboveSiteFlat();
    await zoomDownFlat();
    e.preventDefault();
  }

  if (k === "t") {
    autoAdvance = !autoAdvance;
    if (autoAdvance) runTour();
    e.preventDefault();
  }
});

// =============================================================
// STARTUP
// =============================================================
async function main() {
  const siteObjs = await loadSitesFromExcel();
  entities = addSitesToMap(siteObjs);

  // If you want, you can zoom to all points once:
  await viewer.zoomTo(viewer.entities);

  runTour();
}

main().catch((err) => {
  console.error(err);
  alert(err.message || String(err));
});
