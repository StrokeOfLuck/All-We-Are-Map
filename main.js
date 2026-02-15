// =============================================================
// FULL WORKING SCRIPT (YOUR TOUR/UI + MANUAL CLUSTERING)
// Data format: Impact_Map_Export - Sheet1.csv
// Features:
// 1) Filters to Installed systems only
// 2) Joins Customer -> Location -> Population (latest year)
// 3) Plots sites
// 4) Manual clustering when zoomed out (NO Cesium clustering)
//    Cluster bubble shows: count of sites + total population
// 5) Keeps your auto tour, sidebar, keyboard shortcuts, double click
// =============================================================

Cesium.Ion.defaultAccessToken = "";

const viewer = new Cesium.Viewer("cesiumContainer", {
  animation: false,
  timeline: false,
  baseLayerPicker: false,
  sceneModePicker: true,
  geocoder: true,
  imageryProvider: false,
  terrainProvider: new Cesium.EllipsoidTerrainProvider(),
});

viewer.resolutionScale = window.devicePixelRatio;

const canvas = viewer.scene.canvas;
canvas.setAttribute("tabindex", "0");
canvas.focus();

viewer.imageryLayers.addImageryProvider(
  new Cesium.UrlTemplateImageryProvider({
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    credit: "Esri World Imagery",
  })
);

// =============================================================
// TOUR KNOBS (yours)
// =============================================================
const overviewRangeMeters = 1300000;
const siteRangeMeters = 1200;

const travelSeconds = 1.5;
const zoomInSeconds = 2.0;
const tiltSeconds = 1.6;

const orbitPitchDeg = -45;
const orbitSpeedDegPerSec = 8;
const holdSeconds = 3;

const flatHeadingDeg = 0;
const flatPitchDeg = -90;

let autoAdvance = true;

// =============================================================
// MANUAL CLUSTER KNOBS (your merge controls)
// =============================================================
const CSV_URL = "Impact_Map_Export - Sheet1.csv";

// Below this camera height => show pins
const CLUSTER_MODE_MIN_HEIGHT = 12_000;

// Above this height => force ONE mega bubble
const FULL_MERGE_MIN_HEIGHT = 1_000_000;

// Between those heights => ramp grid size (bigger grid = more merging)
const GRID_DEG_NEAR = 0.15;
const GRID_DEG_FAR = 2.50;

const CLUSTER_MIN_SCALE = 1.0;
const CLUSTER_MAX_SCALE = 2.2;

// =============================================================
// DATA + STATE (yours)
// =============================================================
const entities = []; // site entities (pins) used by tour
const siteItems = []; // sidebar list: { name, customerId, lat, lon, population, entity }

let activeIndex = 0;
let orbit = false;
let headingDeg = 0;
let lastPerf = performance.now();
let isFlying = false;

let tourRunId = 0;

// NEW: canonical site data for clustering
const sites = []; // {id,name,lat,lon,pop,year,locId}

// =============================================================
// DATA SOURCES
// - sitesDS holds pins (your normal entities)
// - clusterDS holds cluster bubbles
// =============================================================
const sitesDS = new Cesium.CustomDataSource("sites");
viewer.dataSources.add(sitesDS);

const clusterDS = new Cesium.CustomDataSource("clusters");
viewer.dataSources.add(clusterDS);

// =============================================================
// CLUSTER BUBBLE IMAGE
// =============================================================
function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function fmtInt(n) {
  const x = Math.round(Number(n) || 0);
  return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function makeClusterBubbleDataUrl({
  diameter = 72,
  fill = "rgba(255,215,0,0.95)",
  stroke = "rgba(0,0,0,0.85)",
  strokeWidth = 4,
} = {}) {
  const r = diameter / 2;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${diameter}" height="${diameter}" viewBox="0 0 ${diameter} ${diameter}">
      <defs>
        <filter id="s" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="rgba(0,0,0,0.35)"/>
        </filter>
      </defs>
      <circle cx="${r}" cy="${r}" r="${r - strokeWidth}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" filter="url(#s)"/>
    </svg>
  `.trim();
  return "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg);
}
const CLUSTER_BUBBLE_URL = makeClusterBubbleDataUrl({ diameter: 72 });

// =============================================================
// TOUR HELPERS (yours)
// =============================================================
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getActiveSitePosition() {
  return entities[activeIndex].position.getValue(Cesium.JulianDate.now());
}

function setActiveIndexFromEntity(entity) {
  const idx = entities.indexOf(entity);
  if (idx !== -1) activeIndex = idx;
}

function updateTourButton() {
  const btn = document.getElementById("fcTourBtn");
  if (!btn) return;
  btn.textContent = autoAdvance ? "❚❚" : "▶";
  btn.setAttribute("aria-label", autoAdvance ? "Pause auto tour" : "Start auto tour");
}

function hardUnlockCamera() {
  autoAdvance = false;
  orbit = false;
  tourRunId++;

  try {
    viewer.camera.cancelFlight();
  } catch (_) {}

  viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  canvas.focus();
  updateTourButton();

  // allow clustering again after user takes control
  requestClusterRefresh();
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
    durationSec: travelSeconds / 2,
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

async function runTourGuarded() {
  const myId = ++tourRunId;

  // TOUR MUST SEE PINS (never clusters)
  sitesDS.show = true;
  clusterDS.show = false;

  while (autoAdvance && myId === tourRunId && entities.length > 0) {
    await goAboveSiteFlat();
    if (!autoAdvance || myId !== tourRunId) break;

    await zoomDownFlat();
    if (!autoAdvance || myId !== tourRunId) break;

    await tiltIntoOrbitPitch();
    if (!autoAdvance || myId !== tourRunId) break;

    headingDeg = 0;
    orbit = true;
    await sleep(holdSeconds * 1000);
    if (!autoAdvance || myId !== tourRunId) break;

    orbit = false;
    await tiltBackToFlat();
    if (!autoAdvance || myId !== tourRunId) break;

    await goAboveSiteFlat();
    if (!autoAdvance || myId !== tourRunId) break;

    activeIndex = (activeIndex + 1) % entities.length;
  }

  // when tour ends, allow clustering again
  requestClusterRefresh();
}

function toggleAutoTour() {
  autoAdvance = !autoAdvance;

  if (autoAdvance) {
    if (entities.length > 0) runTourGuarded();
  } else {
    orbit = false;
    tourRunId++;
    requestClusterRefresh();
  }

  updateTourButton();
}

// =============================================================
// CSV HELPERS (yours)
// =============================================================
function parseCSV(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

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
  if (x == null) return null;
  const s = String(x).replace(/\u00A0/g, " ").trim().replace(/,/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parseCoordinatesLatLon(coordStr) {
  if (!coordStr) return null;

  const parts = String(coordStr)
    .replace(/^"+|"+$/g, "")
    .split(",")
    .map((s) => s.trim());

  if (parts.length < 2) return null;

  const lat = toNum(parts[0]);
  const lon = toNum(parts[1]);
  if (lat == null || lon == null) return null;

  return { lat, lon };
}

function popToPixelSize(pop) {
  if (pop == null) return 10;
  const p = Math.max(0, Number(pop) || 0);
  const size = 6 + Math.log10(Math.max(p, 1)) * 6;
  return clamp(size, 6, 34);
}

// =============================================================
// MANUAL CLUSTERING CORE
// =============================================================
function clearClusterEntities() {
  clusterDS.entities.removeAll();
}

function gridSizeDegForHeight(h) {
  const t = clamp((h - CLUSTER_MODE_MIN_HEIGHT) / (FULL_MERGE_MIN_HEIGHT - CLUSTER_MODE_MIN_HEIGHT), 0, 1);
  return lerp(GRID_DEG_NEAR, GRID_DEG_FAR, t);
}

function buildGridClusters(gridDeg) {
  const buckets = new Map(); // key -> {count,popSum,latSum,lonSum}

  for (const s of sites) {
    const gx = Math.floor(s.lon / gridDeg);
    const gy = Math.floor(s.lat / gridDeg);
    const key = `${gx},${gy}`;

    let b = buckets.get(key);
    if (!b) {
      b = { count: 0, popSum: 0, latSum: 0, lonSum: 0 };
      buckets.set(key, b);
    }
    b.count++;
    b.popSum += s.pop;
    b.latSum += s.lat;
    b.lonSum += s.lon;
  }

  const clusters = [];
  for (const b of buckets.values()) {
    clusters.push({
      count: b.count,
      popSum: b.popSum,
      lat: b.latSum / b.count,
      lon: b.lonSum / b.count,
    });
  }
  return clusters;
}

function renderGridClusters() {
  clearClusterEntities();

  const h = viewer.camera.positionCartographic.height;
  const gridDeg = gridSizeDegForHeight(h);
  const clusters = buildGridClusters(gridDeg);

  for (const c of clusters) {
    const scale = clamp(
      1.0 + Math.log10(Math.max(c.count, 1)) * 0.35,
      CLUSTER_MIN_SCALE,
      CLUSTER_MAX_SCALE
    );

    clusterDS.entities.add({
      position: Cesium.Cartesian3.fromDegrees(c.lon, c.lat),
      properties: {
        isCluster: true,
        count: c.count,
        popSum: c.popSum,
        mega: false,
      },
      billboard: {
        image: CLUSTER_BUBBLE_URL,
        width: 56,
        height: 56,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scale,
      },
      label: {
        text: `Sites: ${c.count}\nPop: ${fmtInt(c.popSum)}`,
        font: "bold 16px sans-serif",
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 6,
        showBackground: true,
        backgroundColor: new Cesium.Color(0, 0, 0, 0.35),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scale,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        pixelOffset: new Cesium.Cartesian2(0, 0),
      },
    });
  }
}

function renderMegaCluster() {
  clearClusterEntities();

  let popSum = 0;
  let latSum = 0;
  let lonSum = 0;

  for (const s of sites) {
    popSum += s.pop;
    latSum += s.lat;
    lonSum += s.lon;
  }

  const count = sites.length;
  const lat = latSum / count;
  const lon = lonSum / count;

  clusterDS.entities.add({
    position: Cesium.Cartesian3.fromDegrees(lon, lat),
    properties: { isCluster: true, count, popSum, mega: true },
    billboard: {
      image: CLUSTER_BUBBLE_URL,
      width: 64,
      height: 64,
      verticalOrigin: Cesium.VerticalOrigin.CENTER,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      scale: CLUSTER_MAX_SCALE,
    },
    label: {
      text: `Sites: ${count}\nPop: ${fmtInt(popSum)}`,
      font: "bold 16px sans-serif",
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 6,
      showBackground: true,
      backgroundColor: new Cesium.Color(0, 0, 0, 0.35),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      scale: CLUSTER_MAX_SCALE,
      verticalOrigin: Cesium.VerticalOrigin.CENTER,
      horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
      pixelOffset: new Cesium.Cartesian2(0, 0),
    },
  });
}

function refreshClusterMode() {
  // If tour running or orbiting, NEVER hide pins (tour needs entities)
  if (autoAdvance || orbit) {
    sitesDS.show = true;
    clusterDS.show = false;
    return;
  }

  const h = viewer.camera.positionCartographic.height;

  if (h >= FULL_MERGE_MIN_HEIGHT) {
    renderMegaCluster();
    sitesDS.show = false;
    clusterDS.show = true;
    return;
  }

  if (h >= CLUSTER_MODE_MIN_HEIGHT) {
    renderGridClusters();
    sitesDS.show = false;
    clusterDS.show = true;
    return;
  }

  // Pins mode
  sitesDS.show = true;
  clusterDS.show = false;
}

let clusterRefreshTimer = null;
function requestClusterRefresh() {
  if (clusterRefreshTimer) clearTimeout(clusterRefreshTimer);
  clusterRefreshTimer = setTimeout(() => {
    clusterRefreshTimer = null;
    refreshClusterMode();
  }, 80);
}

// =============================================================
// MAIN (your original loader, plus fills `sites[]` for clustering)
// =============================================================
async function buildEntitiesFromCSV() {
  const res = await fetch(encodeURI(CSV_URL));
  if (!res.ok) {
    console.error(`Failed to fetch ${CSV_URL}:`, res.status, res.statusText);
    return;
  }

  const text = await res.text();
  const rows = parseCSV(text);
  if (rows.length < 2) {
    console.warn(`${CSV_URL} has no data rows.`);
    return;
  }

  // Layout indices (0-based)
  const IDX_INST_CUST_ID = 0; // A
  const IDX_INST_STATUS = 4;  // E

  const IDX_POP_CUST_ID = 8;  // I
  const IDX_POP_YEAR = 9;     // J
  const IDX_POP_VALUE = 10;   // K

  const IDX_LOC_ID = 14;      // O
  const IDX_LOC_COORDS = 16;  // Q

  const IDX_CUST_ID = 18;     // S
  const IDX_CUST_NAME = 19;   // T
  const IDX_CUST_LOC_ID = 21; // V

  // Reset
  sitesDS.entities.removeAll();
  clusterDS.entities.removeAll();
  entities.length = 0;
  siteItems.length = 0;
  sites.length = 0;

  // PASS 0: Installed IDs
  const installedIds = new Set();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const custIdNum = toNum(row[IDX_INST_CUST_ID]);
    if (custIdNum == null) continue;
    const status = String(row[IDX_INST_STATUS] ?? "").trim().toLowerCase();
    if (status === "installed") installedIds.add(String(Math.trunc(custIdNum)));
  }

  // PASS 1: latest population per customer
  const popById = new Map(); // id -> {year,pop}
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const idNum = toNum(row[IDX_POP_CUST_ID]);
    const yearNum = toNum(row[IDX_POP_YEAR]);
    const popNum = toNum(row[IDX_POP_VALUE]);
    if (idNum == null || yearNum == null || popNum == null) continue;

    const id = String(Math.trunc(idNum));
    const year = Math.trunc(yearNum);
    const pop = popNum;

    const prev = popById.get(id);
    if (!prev || year > prev.year || (year === prev.year && pop > prev.pop)) {
      popById.set(id, { year, pop });
    }
  }

  // PASS 2: coords by locId
  const coordsByLocId = new Map();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const locIdNum = toNum(row[IDX_LOC_ID]);
    if (locIdNum == null) continue;
    const coord = parseCoordinatesLatLon(row[IDX_LOC_COORDS]);
    if (!coord) continue;
    coordsByLocId.set(String(Math.trunc(locIdNum)), coord);
  }

  // PASS 3: customerById
  const customerById = new Map(); // id -> {name,locId}
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const idNum = toNum(row[IDX_CUST_ID]);
    if (idNum == null) continue;

    const name = String(row[IDX_CUST_NAME] ?? "").trim();
    const locIdNum = toNum(row[IDX_CUST_LOC_ID]);
    if (!name || locIdNum == null) continue;

    const id = String(Math.trunc(idNum));
    if (!customerById.has(id)) {
      customerById.set(id, { name, locId: String(Math.trunc(locIdNum)) });
    }
  }

  // PASS 4: plot pins + also fill `sites[]`
  let plotted = 0;
  let missingCustomer = 0;
  let missingCoords = 0;
  let missingPop = 0;

  for (const id of installedIds) {
    const cust = customerById.get(id);
    if (!cust) {
      missingCustomer++;
      continue;
    }

    const coord = coordsByLocId.get(cust.locId);
    if (!coord) {
      missingCoords++;
      continue;
    }

    const popRec = popById.get(id);
    if (!popRec || popRec.pop == null || popRec.pop <= 0) {
      missingPop++;
      continue;
    }

    const { lat, lon } = coord;
    const pop = popRec.pop;

    // canonical record for clustering
    sites.push({
      id,
      name: cust.name,
      lat,
      lon,
      pop,
      year: popRec.year,
      locId: cust.locId,
    });

    const labelText = `${cust.name}\nPopulation served: ${fmtInt(pop)}`;

    const entity = sitesDS.entities.add({
      name: cust.name,
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
      properties: {
        customerId: id,
        population: pop,
        year: popRec.year,
        locId: cust.locId,
        isCluster: false,
      },
      point: {
        pixelSize: popToPixelSize(pop),
        color: Cesium.Color.YELLOW,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      billboard: {
        image: "./icons/solar_pin.png",
        width: 28,
        height: 28,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(1_000.0, 1.0, 5_000_000.0, 0.4),
      },
      label: {
        text: labelText,
        font: "bold 18px sans-serif",
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 5,
        showBackground: true,
        backgroundColor: new Cesium.Color(0, 0, 0, 0.55),
        pixelOffset: new Cesium.Cartesian2(0, -40),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        translucencyByDistance: new Cesium.NearFarScalar(20_000, 1.0, 200_000, 0.0),
        scaleByDistance: new Cesium.NearFarScalar(20_000, 1.0, 200_000, 0.0),
      },
    });

    entities.push(entity);
    siteItems.push({
      name: cust.name,
      customerId: id,
      lat,
      lon,
      population: pop,
      entity,
    });

    plotted++;
  }

  console.log("Installed customer IDs:", installedIds.size);
  console.log("Plotted installed sites:", plotted);
  console.log("Missing customer row:", missingCustomer);
  console.log("Missing coords:", missingCoords);
  console.log("Missing population:", missingPop);
}

// =============================================================
// SIDEBAR (yours)
// =============================================================
function flyToSite(entity) {
  autoAdvance = false;
  orbit = false;
  tourRunId++;
  updateTourButton();

  // when user picks a site, make sure pins are visible
  sitesDS.show = true;
  clusterDS.show = false;

  setActiveIndexFromEntity(entity);

  viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);

  const pos = entity.position.getValue(Cesium.JulianDate.now());

  viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(pos, 1.0), {
    duration: 1.2,
    offset: new Cesium.HeadingPitchRange(
      Cesium.Math.toRadians(0),
      Cesium.Math.toRadians(flatPitchDeg),
      siteRangeMeters
    ),
    complete: () => {
      canvas.focus();
      requestClusterRefresh();
    },
  });
}

function renderSiteList(filterText = "") {
  const listEl = document.getElementById("siteList");
  if (!listEl) return;

  listEl.innerHTML = "";

  const q = filterText.trim().toLowerCase();
  const filtered = q
    ? siteItems.filter(
        (s) =>
          (s.name || "").toLowerCase().includes(q) ||
          (s.customerId || "").toLowerCase().includes(q)
      )
    : siteItems;

  filtered.forEach((s) => {
    const row = document.createElement("div");
    row.className = "siteRow";

    const popLine = `<div class="siteSub">Pop: ${fmtInt(s.population)}</div>`;

    row.innerHTML = `
      <div>${s.name}</div>
      <div class="siteSub">ID: ${s.customerId}</div>
      ${popLine}
    `;

    row.addEventListener("click", (e) => {
      e.stopPropagation();
      flyToSite(s.entity);
    });

    listEl.appendChild(row);
  });
}

function wireSearchBox() {
  const input = document.getElementById("siteSearch");
  if (!input) return;
  input.addEventListener("input", () => renderSiteList(input.value));
}

// =============================================================
// DOUBLE CLICK (yours, upgraded to also zoom clusters)
// =============================================================
viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(
  Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK
);

let lastClickAt = 0;
const DOUBLE_CLICK_MS = 320;

const safeClickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
safeClickHandler.setInputAction((movement) => {
  const nowPerf = performance.now();
  const isDouble = nowPerf - lastClickAt < DOUBLE_CLICK_MS;
  lastClickAt = nowPerf;

  if (!isDouble) return;

  const picked = viewer.scene.pick(movement.position);
  if (!picked || !picked.id || !picked.id.position) return;

  const now = Cesium.JulianDate.now();
  const isCluster = picked.id.properties?.isCluster?.getValue?.(now);

  if (isCluster) {
    const pos = picked.id.position.getValue(now);
    viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(pos, 1.0), {
      duration: 0.9,
      offset: new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(0),
        Cesium.Math.toRadians(-60),
        Math.max(35_000, viewer.camera.positionCartographic.height * 0.35)
      ),
      complete: () => requestClusterRefresh(),
    });
    return;
  }

  flyToSite(picked.id);
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

// =============================================================
// SINGLE CLICK: cluster click zooms in (doesn't interfere with sidebar clicks)
// =============================================================
const clusterClickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
clusterClickHandler.setInputAction((movement) => {
  const picked = viewer.scene.pick(movement.position);
  if (!picked || !picked.id || !picked.id.position) return;

  const now = Cesium.JulianDate.now();
  const isCluster = picked.id.properties?.isCluster?.getValue?.(now);
  if (!isCluster) return;

  const pos = picked.id.position.getValue(now);
  viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(pos, 1.0), {
    duration: 0.8,
    offset: new Cesium.HeadingPitchRange(
      Cesium.Math.toRadians(0),
      Cesium.Math.toRadians(-60),
      Math.max(35_000, viewer.camera.positionCartographic.height * 0.35)
    ),
    complete: () => requestClusterRefresh(),
  });
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

// =============================================================
// HARD UNLOCK ON USER INPUT (yours)
// =============================================================
canvas.addEventListener(
  "pointerdown",
  (e) => {
    if (e.target !== canvas) return;
    hardUnlockCamera();
  },
  true
);

canvas.addEventListener(
  "wheel",
  (e) => {
    if (e.target !== canvas) return;
    hardUnlockCamera();
  },
  { capture: true, passive: true }
);

canvas.addEventListener(
  "touchstart",
  (e) => {
    if (e.target !== canvas) return;
    hardUnlockCamera();
  },
  { capture: true, passive: true }
);

// =============================================================
// KEYBOARD SHORTCUTS (yours)
// =============================================================
window.addEventListener(
  "keydown",
  async (e) => {
    const active = document.activeElement;
    const isSearch = active && active.id === "siteSearch";

    const k = e.key.toLowerCase();
    const isShortcut = k === "r" || k === "t" || k === "n" || k === "p" || k === "h";

    if (isSearch && !isShortcut) return;

    if (isSearch && isShortcut) {
      active.blur();
      canvas.focus();
    }

    if (k === "h") {
      const help = document.getElementById("controlsHelp");
      if (help) help.classList.toggle("controlsHelpHidden");
      e.preventDefault();
      return;
    }

    if (entities.length === 0) return;

    if (k === "r") {
      autoAdvance = false;
      orbit = false;
      viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);

      // ensure pins visible
      sitesDS.show = true;
      clusterDS.show = false;

      await zoomDownFlat();
      await tiltIntoOrbitPitch();
      headingDeg = 0;
      orbit = true;

      e.preventDefault();
      return;
    }

    if (k === "n") {
      autoAdvance = false;
      orbit = false;
      viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);

      sitesDS.show = true;
      clusterDS.show = false;

      activeIndex = (activeIndex + 1) % entities.length;
      await goAboveSiteFlat();
      await zoomDownFlat();

      e.preventDefault();
      return;
    }

    if (k === "p") {
      autoAdvance = false;
      orbit = false;
      viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);

      sitesDS.show = true;
      clusterDS.show = false;

      activeIndex = (activeIndex - 1 + entities.length) % entities.length;
      await goAboveSiteFlat();
      await zoomDownFlat();

      e.preventDefault();
      return;
    }

    if (k === "t") {
      orbit = false;
      viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);

      toggleAutoTour();
      e.preventDefault();
      return;
    }
  },
  true
);

// =============================================================
// Floating controls (yours)
// =============================================================
(function wireFloatingControls() {
  const sidebar = document.getElementById("sidebar");
  const menuBtn = document.getElementById("fcMenuBtn");
  const tourBtn = document.getElementById("fcTourBtn");

  if (!sidebar || !menuBtn || !tourBtn) return;

  const mqMobile = window.matchMedia("(max-width: 768px)");

  function isClosed() {
    return sidebar.classList.contains("sidebarClosed");
  }

  function updateMenuButton() {
    menuBtn.textContent = isClosed() ? "☰" : "✕";
    menuBtn.setAttribute("aria-label", isClosed() ? "Open locations menu" : "Close locations menu");
  }

  function applyInitialSidebarState() {
    sidebar.classList.add("sidebarClosed");
    updateMenuButton();
  }

  function toggleMenu() {
    sidebar.classList.toggle("sidebarClosed");
    updateMenuButton();
  }

  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu();
  });

  tourBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleAutoTour();
  });

  sidebar.addEventListener("pointerdown", (e) => e.stopPropagation());
  sidebar.addEventListener("click", (e) => e.stopPropagation());

  if (mqMobile.addEventListener) mqMobile.addEventListener("change", applyInitialSidebarState);
  else window.addEventListener("resize", applyInitialSidebarState);

  applyInitialSidebarState();
  updateTourButton();
})();

// =============================================================
// CLUSTER MODE REFRESH HOOKS
// =============================================================
viewer.camera.moveEnd.addEventListener(requestClusterRefresh);
viewer.camera.changed.addEventListener(requestClusterRefresh);

// =============================================================
// START
// =============================================================
(async function init() {
  await buildEntitiesFromCSV();

  wireSearchBox();
  renderSiteList();

  if (entities.length === 0) {
    console.warn("No coordinate sites found to show.");
    return;
  }

  // zoom to pins
  viewer.zoomTo(sitesDS.entities);

  // pick the right mode for current height (pins vs clusters)
  refreshClusterMode();

  autoAdvance = true;
  runTourGuarded();
})();
