// =============================================================
// FULL WORKING SCRIPT (2-pass, NO SKIPPING COORD SITES)
// + CLUSTERING (merge/split) with "big bubble -> splits -> splits"
// + Cluster bubble CENTER TEXT (population + site count) visible from FAR away
// + Individual sites keep CUSTOMER NAME from CSV + population label (near only)
// + IMPORTANT: At <= noClusterAtOrBelowMeters, clustering is HARD OFF
//
// UPDATE: Better “merge together” control
// - NEW knobs:
//   1) clusterPixelRangeFar: how aggressively clusters merge (bigger = more merging)
//   2) clusterRangeNearMeters/clusterRangeFarMeters: where clustering ramps on/off
//   3) clusterMaxPixelRange: cap for extreme zoomed-out cases
// - Behavior:
//   * At/under noClusterAtOrBelowMeters => clustering OFF (true smallest dots)
//   * From noClusterAtOrBelowMeters up to maxpixel=> ramps ON gently
//   * By clusterRangeFarMeters and beyond => full pixelRangeFar
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
// KNOBS
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

// -------------------------------------------------------------
// CLUSTERING MERGE CONTROLS (NEW)
// -------------------------------------------------------------

const noClusterAtOrBelowMeters = 75000;
const clusterPixelRangeFar = 260;
const clusterMinSize = 2;

const clusterRangeNearMeters = noClusterAtOrBelowMeters; // start ramp here
const clusterRangeFarMeters  = 250_000;

const clusterMaxPixelRange = 400;
const forceReclusterOnPixelRangeChange = false;

// ---- Site label fade (near only) ----
const siteLabelNear = 0;       // fully visible at 1200m
const siteLabelFar = 80_000;
const siteLabelFarAlpha = 0.0;

// ---- Cluster center text visibility (ITS OWN THING) ----
const clusterTextNear = 10_000;
const clusterTextFar = 10_000_000;
const clusterTextFarAlpha = 0.85;

// ---- Cluster bubble sizing (SNAPPED) ----
const clusterSizeBuckets = [18, 26, 34, 44, 56, 70, 86, 104];
const clusterSizeByPopulation = true;
const showClusterSiteCount = true;

// =============================================================
// DATA + STATE
// =============================================================
const entities = [];
const siteItems = []; // { name, customerId, lat, lon, population|null, entity }

let activeIndex = 0;
let orbit = false;
let headingDeg = 0;
let lastPerf = performance.now();
let isFlying = false;

let tourRunId = 0;

// Clustered datasource
const sitesDS = new Cesium.CustomDataSource("sites");
viewer.dataSources.add(sitesDS);

sitesDS.clustering.enabled = true;
sitesDS.clustering.pixelRange = clusterPixelRangeFar;
sitesDS.clustering.minimumClusterSize = clusterMinSize;

// Track last state so we only toggle when needed
let clusteringIsOn = true;
let lastPixelRange = sitesDS.clustering.pixelRange;

// =============================================================
// HELPERS
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
    headingDegValue: 0,
    durationSec: travelSeconds / 2,
  });
}

async function zoomDownFlat() {
  orbit = false;
  headingDeg = 0;
  await flyToRange({
    rangeMeters: siteRangeMeters,
    pitchDeg: flatPitchDeg,
    headingDegValue: 0,
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
    headingDegValue: 0,
    durationSec: tiltSeconds,
  });
}

// =============================================================
// CLUSTERING CONTROL: HARD OFF under threshold + SMOOTH RAMP
// =============================================================

// Smoothstep helper (0..1) -> (0..1) eased
function smoothstep(t) {
  t = Cesium.Math.clamp(t, 0.0, 1.0);
  return t * t * (3 - 2 * t);
}

function computeDynamicPixelRange(height) {
  // If you want “merge more” even earlier, lower clusterRangeFarMeters,
  // or raise clusterPixelRangeFar.
  const t = (height - clusterRangeNearMeters) / (clusterRangeFarMeters - clusterRangeNearMeters);
  const eased = smoothstep(t);
  const px = Math.round(eased * clusterPixelRangeFar);
  return Math.min(clusterMaxPixelRange, Math.max(0, px));
}

function updateClusteringByCameraDistance() {
  const height = viewer.camera.positionCartographic.height;

  // HARD OFF close-in
  const shouldCluster = height > noClusterAtOrBelowMeters;

  if (!shouldCluster) {
    if (clusteringIsOn) {
      clusteringIsOn = false;
      sitesDS.clustering.enabled = false; // hard off
    }
    return;
  }

  // If we’re here, clustering should be ON
  if (!clusteringIsOn) {
    clusteringIsOn = true;
    sitesDS.clustering.minimumClusterSize = clusterMinSize;
    sitesDS.clustering.enabled = true;
    // set pixel range right away based on current height
    lastPixelRange = -1;
  }

  // Dynamic pixelRange to improve “merge together”
  const desiredPx = computeDynamicPixelRange(height);

  if (desiredPx !== lastPixelRange) {
    sitesDS.clustering.pixelRange = desiredPx;
    lastPixelRange = desiredPx;

    if (forceReclusterOnPixelRangeChange) {
      // Nudge recluster immediately
      sitesDS.clustering.enabled = false;
      sitesDS.clustering.enabled = true;
    }
  }
}

// =============================================================
// TOUR TICK
// =============================================================
viewer.clock.onTick.addEventListener(() => {
  updateClusteringByCameraDistance();

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

  while (autoAdvance && myId === tourRunId && entities.length > 0) {
    await goAboveSiteFlat();
    if (!autoAdvance || myId !== tourRunId) break;

    await zoomDownFlat(); // ends at ~1200m (and clustering will be OFF)
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
}

function toggleAutoTour() {
  autoAdvance = !autoAdvance;

  if (autoAdvance) {
    if (entities.length > 0) runTourGuarded();
  } else {
    orbit = false;
    tourRunId++;
  }

  updateTourButton();
}

// =============================================================
// CSV HELPERS
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

function fmtInt(n) {
  const x = Math.round(Number(n) || 0);
  return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

function popToPixelSize(pop) {
  if (pop == null) return 10;
  const p = Math.max(0, Number(pop) || 0);
  const size = 6 + Math.log10(Math.max(p, 1)) * 6;
  return clamp(size, 6, 34);
}

function pickBucketSize(rawSize) {
  let pixelSize = clusterSizeBuckets[clusterSizeBuckets.length - 1];
  for (const b of clusterSizeBuckets) {
    if (rawSize <= b) {
      pixelSize = b;
      break;
    }
  }
  return pixelSize;
}

function clusterFontForBubble(pixelSize) {
  const s = clamp(Math.round(pixelSize * 0.33), 12, 28);
  return `bold ${s}px sans-serif`;
}

// =============================================================
// CLUSTER EVENT (bubble + CENTER TEXT)
// =============================================================
sitesDS.clustering.clusterEvent.addEventListener((clusteredEntities, cluster) => {
  const now = Cesium.JulianDate.now();

  let sumPop = 0;
  for (const e of clusteredEntities) {
    const p = e.properties?.population?.getValue?.(now);
    if (Number.isFinite(p)) sumPop += p;
  }

  let rawSize;
  if (clusterSizeByPopulation) {
    rawSize = 16 + Math.log10(Math.max(sumPop, 1)) * 18;
  } else {
    const n = clusteredEntities.length;
    rawSize = 18 + Math.sqrt(n) * 12;
  }

  const pixelSize = pickBucketSize(rawSize);

  cluster.billboard.show = false;

  cluster.point.show = true;
  cluster.point.pixelSize = pixelSize;
  cluster.point.color = Cesium.Color.YELLOW.withAlpha(0.88);
  cluster.point.outlineColor = Cesium.Color.BLACK;
  cluster.point.outlineWidth = 2;
  cluster.point.disableDepthTestDistance = Number.POSITIVE_INFINITY;

  cluster.label.show = true;
  
  cluster.label.text = fmtInt(sumPop); // population ONLY
  const popLine = `Pop: ${fmtInt(sumPop)}`;
  const countLine = showClusterSiteCount ? `\nSites: ${clusteredEntities.length}` : "";
  //cluster.label.text = `${popLine}${countLine}`;

  cluster.label.verticalOrigin = Cesium.VerticalOrigin.CENTER;
  cluster.label.horizontalOrigin = Cesium.HorizontalOrigin.CENTER;
  cluster.label.pixelOffset = Cesium.Cartesian2.ZERO;
  cluster.label.eyeOffset = Cesium.Cartesian3.ZERO;
  cluster.label.heightReference = Cesium.HeightReference.NONE;
  cluster.label.disableDepthTestDistance = Number.POSITIVE_INFINITY;

  cluster.label.showBackground = false;
  cluster.label.font = clusterFontForBubble(pixelSize);
  cluster.label.fillColor = Cesium.Color.BLACK;
  cluster.label.outlineWidth = 0;

  cluster.label.translucencyByDistance = new Cesium.NearFarScalar(
    clusterTextNear,
    1.0,
    clusterTextFar,
    clusterTextFarAlpha
  );
  cluster.label.scaleByDistance = new Cesium.NearFarScalar(
    clusterTextNear,
    1.0,
    clusterTextFar,
    1.0
  );
});

// =============================================================
// MAIN (Impact_Map_Export - Sheet1.csv)
// =============================================================
async function buildEntitiesFromCSV() {
  const CSV_URL = "Impact_Map_Export - Sheet1.csv";

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

  const IDX_INST_CUST_ID = 0;
  const IDX_INST_STATUS = 4;

  const IDX_POP_CUST_ID = 8;
  const IDX_POP_YEAR = 9;
  const IDX_POP_VALUE = 10;

  const IDX_LOC_ID = 14;
  const IDX_LOC_COORDS = 16;

  const IDX_CUST_ID = 18;
  const IDX_CUST_NAME = 19;
  const IDX_CUST_LOC_ID = 21;

  sitesDS.entities.removeAll();
  entities.length = 0;
  siteItems.length = 0;

  const installedIds = new Set();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const custIdNum = toNum(row[IDX_INST_CUST_ID]);
    if (custIdNum == null) continue;

    const status = String(row[IDX_INST_STATUS] ?? "").trim().toLowerCase();
    if (status !== "installed") continue;

    installedIds.add(String(Math.trunc(custIdNum)));
  }

  const popById = new Map();
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

  const coordsByLocId = new Map();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];

    const locIdNum = toNum(row[IDX_LOC_ID]);
    if (locIdNum == null) continue;

    const coord = parseCoordinatesLatLon(row[IDX_LOC_COORDS]);
    if (!coord) continue;

    coordsByLocId.set(String(Math.trunc(locIdNum)), coord);
  }

  const customerById = new Map();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];

    const idNum = toNum(row[IDX_CUST_ID]);
    if (idNum == null) continue;

    const name = String(row[IDX_CUST_NAME] ?? "").trim();
    const locIdNum = toNum(row[IDX_CUST_LOC_ID]);
    if (!name || locIdNum == null) continue;

    const id = String(Math.trunc(idNum));
    const locId = String(Math.trunc(locIdNum));
    if (!customerById.has(id)) customerById.set(id, { name, locId });
  }

  let plotted = 0;

  for (const id of installedIds) {
    const cust = customerById.get(id);
    if (!cust) continue;

    const coord = coordsByLocId.get(cust.locId);
    if (!coord) continue;

    const popRec = popById.get(id);
    if (!popRec || popRec.pop == null) continue;

    const pop = popRec.pop;
    if (pop <= 0) continue;

    const { lat, lon } = coord;
    const customerName = cust.name;

    const entity = sitesDS.entities.add({
      name: customerName,
      position: Cesium.Cartesian3.fromDegrees(lon, lat),

      properties: {
        customerId: id,
        customerName,
        population: pop,
        year: popRec.year,
        locId: cust.locId,
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
        text: `${customerName}\nPopulation served: ${fmtInt(pop)}`,
        font: "bold 18px sans-serif",
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 5,
        showBackground: true,
        backgroundColor: new Cesium.Color(0, 0, 0, 0.55),
        pixelOffset: new Cesium.Cartesian2(0, -55),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        translucencyByDistance: new Cesium.NearFarScalar(siteLabelNear, 1.0, siteLabelFar, siteLabelFarAlpha),
        scaleByDistance: new Cesium.NearFarScalar(siteLabelNear, 1.0, siteLabelFar, siteLabelFarAlpha),
      },
    });

    entities.push(entity);
    siteItems.push({
      name: customerName,
      customerId: id,
      lat,
      lon,
      population: pop,
      entity,
    });

    plotted++;
  }

  console.log("Plotted installed sites:", plotted);

  // Force clustering refresh (starts ON)
  sitesDS.clustering.enabled = false;
  sitesDS.clustering.enabled = true;

  // Immediately enforce threshold + ramp
  updateClusteringByCameraDistance();
}

// =============================================================
// SIDEBAR
// =============================================================
function flyToSite(entity) {
  autoAdvance = false;
  orbit = false;
  tourRunId++;
  updateTourButton();

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
    complete: () => canvas.focus(),
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

    const popLine =
      s.population == null
        ? `<div class="siteSub">Pop: (missing)</div>`
        : `<div class="siteSub">Pop: ${fmtInt(s.population)}</div>`;

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
// DOUBLE CLICK
// =============================================================
viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(
  Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK
);

let lastClickAt = 0;
const DOUBLE_CLICK_MS = 320;

const safeClickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
safeClickHandler.setInputAction((movement) => {
  const now = performance.now();
  const isDouble = now - lastClickAt < DOUBLE_CLICK_MS;
  lastClickAt = now;

  if (!isDouble) return;

  const picked = viewer.scene.pick(movement.position);
  if (!picked || !picked.id || !picked.id.position) return;

  flyToSite(picked.id);
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

// =============================================================
// HARD UNLOCK ON USER INPUT
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
// KEYBOARD SHORTCUTS
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
// Floating controls
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

  viewer.zoomTo(sitesDS.entities);

  autoAdvance = true;
  runTourGuarded();
})();
