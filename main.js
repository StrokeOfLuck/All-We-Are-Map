// -------------------------------
// Cesium: no ion tokens needed
// -------------------------------
Cesium.Ion.defaultAccessToken = "";

// -------------------------------
// Viewer (NO default imagery)
// -------------------------------
const viewer = new Cesium.Viewer("cesiumContainer", {
  animation: false,
  timeline: false,
  baseLayerPicker: false,
  sceneModePicker: true,
  geocoder: true,
  imageryProvider: false,
  terrainProvider: new Cesium.EllipsoidTerrainProvider(),
});

// -------------------------------
// Basemap (pick ONE)
// -------------------------------

/*
// -------------------------------
// Add a FREE basemap (no tokens)
// Option A (default): OpenTopoMap (reliable for testing)
// -------------------------------
viewer.imageryLayers.addImageryProvider(
  new Cesium.UrlTemplateImageryProvider({
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    subdomains: ["a", "b", "c"],
    credit: "OpenTopoMap",
  })
);
*/

viewer.imageryLayers.addImageryProvider(
  new Cesium.UrlTemplateImageryProvider({
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    credit: "Esri World Imagery",
  })
);

// =============================================================
// LOAD SITES FROM CSV (NO DEPENDENCIES)
// CSV format (yours):
// - Has a "Coordinates" column like: "0.360129..., 32.581690..."
//   That is LAT, LON (backwards for Cesium)
// - Cesium needs: fromDegrees(LON, LAT)
// Also CSV has multiple rows per customer (Year), so we dedupe:
// - Keep latest Year that still has valid coordinates
// =============================================================

const entities = [];

// Robust CSV parser that handles quoted fields + quoted commas
function parseCSV(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    // Escaped quote inside quotes: ""
    if (ch === '"' && inQuotes && next === '"') {
      cur += '"';
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (ch === "," && !inQuotes) {
      row.push(cur);
      cur = "";
      continue;
    }

    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      // Handle CRLF
      if (ch === "\r" && next === "\n") i++;
      row.push(cur);
      cur = "";
      if (row.some((v) => String(v).trim().length > 0)) rows.push(row);
      row = [];
      continue;
    }

    cur += ch;
  }

  row.push(cur);
  if (row.some((v) => String(v).trim().length > 0)) rows.push(row);

  return rows;
}

function toNum(x) {
  const n = Number(String(x).trim());
  return Number.isFinite(n) ? n : null;
}

// Your CSV "Coordinates" is stored as: "LAT, LON"
function parseCoordinatesLatLon(coordStr) {
  if (!coordStr) return null;
  const parts = String(coordStr)
    .replace(/^"+|"+$/g, "") // strip surrounding quotes if any
    .split(",")
    .map((s) => s.trim());

  if (parts.length < 2) return null;

  const lat = toNum(parts[0]);
  const lon = toNum(parts[1]);
  if (lat == null || lon == null) return null;

  return { lat, lon };
}

async function buildEntitiesFromCSV() {
  const res = await fetch("sites.csv");
  if (!res.ok) {
    console.error("Failed to fetch sites.csv:", res.status, res.statusText);
    return;
  }

  const text = await res.text();
  const rows = parseCSV(text);

  if (rows.length < 2) {
    console.warn("sites.csv has no data rows.");
    return;
  }

  // Normalize headers
  const headers = rows[0].map((h) =>
    String(h).replace("\ufeff", "").trim().toLowerCase()
  );

  const idxCustomerId = headers.indexOf("customer id");
  const idxCustomerName = headers.indexOf("customer name");
  const idxYear = headers.indexOf("year");
  const idxCoordinates = headers.indexOf("coordinates");

  if (idxCoordinates === -1) {
    console.error('CSV missing required column: "Coordinates"');
    return;
  }

  // Deduplicate: Customer ID -> keep newest year with valid coords
  const bestByCustomer = new Map();

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];

    const coord = parseCoordinatesLatLon(r[idxCoordinates]);
    if (!coord) continue;

    const year = idxYear !== -1 ? toNum(r[idxYear]) : null;

    const customerId =
      idxCustomerId !== -1 && String(r[idxCustomerId]).trim()
        ? String(r[idxCustomerId]).trim()
        : `row-${i}`;

    const name =
      idxCustomerName !== -1 && String(r[idxCustomerName]).trim()
        ? String(r[idxCustomerName]).trim()
        : `Site ${customerId}`;

    const prev = bestByCustomer.get(customerId);

    // If none yet, store
    if (!prev) {
      bestByCustomer.set(customerId, { name, year, coord });
      continue;
    }

    // If year exists, keep the newer record
    if (year != null && (prev.year == null || year > prev.year)) {
      bestByCustomer.set(customerId, { name, year, coord });
    }
  }

  // Build Cesium entities
  for (const [, item] of bestByCustomer.entries()) {
    const { lat, lon } = item.coord;

    // IMPORTANT SWAP:
    // CSV gives LAT, LON
    // Cesium needs LON, LAT
    entities.push(
      viewer.entities.add({
        name: item.name,
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        point: {
          pixelSize: 10,
          color: Cesium.Color.YELLOW,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      })
    );
  }

  console.log(`Loaded ${entities.length} unique sites from sites.csv`);
}

// =============================================================
// KNOBS YOU CARE ABOUT
// =============================================================

// Camera distances
const overviewRangeMeters = 450000; // how far OUT between sites (Uganda view)
const siteRangeMeters = 1200; // how close IN at the site

// Travel behavior
const travelSeconds = 1.5; // "move above next site" + "zoom out"
const zoomInSeconds = 2.0; // zooming down flat
const tiltSeconds = 1.6; // how fast it tilts into orbit pitch

// Orbit behavior (ONLY while holding at the site)
const orbitPitchDeg = -45; // the tilt angle once at the site
const orbitSpeedDegPerSec = 8; // rotation speed at the site
const holdSeconds = 6; // how long to rotate at each site

// Flat travel orientation (north-up, no rotation)
const flatHeadingDeg = 0; // north-up
const flatPitchDeg = -90; // straight down

// Auto tour
let autoAdvance = true;

// =============================================================
// INTERNAL STATE
// =============================================================
let activeIndex = 0;
let orbit = false; // IMPORTANT: orbit starts OFF (travel flat)
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

// Wrap flyToBoundingSphere in a Promise (Cesium uses callbacks)
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

// “Travel flat above site” (north-up, straight down, far out)
async function goAboveSiteFlat() {
  orbit = false; // ensure NO rotation during travel
  headingDeg = 0;
  await flyToRange({
    rangeMeters: overviewRangeMeters,
    pitchDeg: flatPitchDeg,
    headingDegValue: flatHeadingDeg,
    durationSec: travelSeconds/2,
  });
}

// “Zoom down flat” (still north-up, straight down, close range)
async function zoomDownFlat() {
  orbit = false; // still NO rotation
  headingDeg = 0;
  await flyToRange({
    rangeMeters: siteRangeMeters,
    pitchDeg: flatPitchDeg,
    headingDegValue: flatHeadingDeg,
    durationSec: zoomInSeconds,
  });
}

// “Tilt into orbit pitch” (no rotate yet, just slant)
async function tiltIntoOrbitPitch() {
  orbit = false; // still not rotating during tilt
  headingDeg = 0;
  await flyToRange({
    rangeMeters: siteRangeMeters,
    pitchDeg: orbitPitchDeg,
    headingDegValue: 0, // start orbit facing north
    durationSec: tiltSeconds,
  });
}

// “Tilt back flat” before leaving (no rotate)
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

  // While orbiting, keep same range + pitch, only change heading
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
// TOUR: flat travel -> flat zoom -> tilt -> rotate -> reverse -> next
// =============================================================
async function runTour() {
  while (autoAdvance) {
    // 1) Move above current site flat (this also helps “re-acquire” if user moved)
    await goAboveSiteFlat();
    if (!autoAdvance) break;

    // 2) Zoom down flat
    await zoomDownFlat();
    if (!autoAdvance) break;

    // 3) Tilt into orbit pitch (still no rotation)
    await tiltIntoOrbitPitch();
    if (!autoAdvance) break;

    // 4) Start rotating at site
    headingDeg = 0;
    orbit = true;
    await sleep(holdSeconds * 1000);

    // 5) Stop rotating, tilt back flat
    orbit = false;
    await tiltBackToFlat();
    if (!autoAdvance) break;

    // 6) Zoom out flat (Uganda view)
    await goAboveSiteFlat();
    if (!autoAdvance) break;

    // 7) Next site
    activeIndex = (activeIndex + 1) % entities.length;
  }
}

// =============================================================
// START (wait for CSV to load first)
// =============================================================
(async function init() {
  await buildEntitiesFromCSV();

  if (entities.length === 0) {
    console.warn("No sites loaded from sites.csv; tour not started.");
    return;
  }

  runTour();
})();

// =============================================================
// CONTROLS
// =============================================================
const canvas = viewer.scene.canvas;
canvas.setAttribute("tabindex", "0");
canvas.focus();

// Click stops the tour and orbit, gives user control
canvas.addEventListener("mousedown", () => {
  autoAdvance = false;
  orbit = false;
  viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
});

canvas.addEventListener("keydown", async (e) => {
  const k = e.key.toLowerCase();

  // R = resume orbit at current site (tilt first, then orbit)
  if (k === "r") {
    autoAdvance = false; // manual mode
    orbit = false;
    await zoomDownFlat();
    await tiltIntoOrbitPitch();
    headingDeg = 0;
    orbit = true;
    e.preventDefault();
  }

  // N = next site (flat travel sequence, no orbit until you press R or restart tour)
  if (k === "n") {
    autoAdvance = false;
    orbit = false;
    activeIndex = (activeIndex + 1) % entities.length;
    await goAboveSiteFlat();
    await zoomDownFlat();
    e.preventDefault();
  }

  // P = previous site
  if (k === "p") {
    autoAdvance = false;
    orbit = false;
    activeIndex = (activeIndex - 1 + entities.length) % entities.length;
    await goAboveSiteFlat();
    await zoomDownFlat();
    e.preventDefault();
  }

  // T = toggle auto tour
  if (k === "t") {
    autoAdvance = !autoAdvance;
    if (autoAdvance) runTour();
    e.preventDefault();
  }
});
