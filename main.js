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

// sharp labels/billboards on high-DPI
viewer.resolutionScale = window.devicePixelRatio;

// Canvas reference + keyboard focus
const canvas = viewer.scene.canvas;
canvas.setAttribute("tabindex", "0");
canvas.focus();

// -------------------------------
// Basemap (pick ONE)
// -------------------------------
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

// =============================================================
// DATA + STATE
// =============================================================
const entities = []; // entities we tour through (these live in popSource)
const siteItems = []; // sidebar list

let activeIndex = 0;
let orbit = false;
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

function setActiveIndexFromEntity(entity) {
  const idx = entities.indexOf(entity);
  if (idx !== -1) activeIndex = idx;
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

// Wrap flyToBoundingSphere in a Promise
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

// =============================================================
// ORBIT LOOP (ONLY while orbit === true)
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
// TOUR (guarded so it can't stack)
// =============================================================
let tourRunId = 0;

async function runTourGuarded() {
  const myId = ++tourRunId;

  while (autoAdvance && myId === tourRunId) {
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
}

// =============================================================
// CSV PARSE
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
  const s = String(x).replace(/\u00A0/g, " ").trim();
  if (!s) return null;
  const cleaned = s.replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function toBool(x) {
  const s = String(x ?? "").trim().toUpperCase();
  return s === "TRUE" || s === "YES" || s === "1";
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

// =============================================================
// POPULATION SOURCE + CLUSTERING
// =============================================================
const popSource = new Cesium.CustomDataSource("populationSites");
viewer.dataSources.add(popSource); // <-- REQUIRED or nothing renders

const CLUSTER_PIXEL_RANGE = 55;
const CLUSTER_MIN_SIZE = 2;

let _bubbleImg = null;
let _lastResetFrame = -1;

function makeBubbleImage(size = 96) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const r = size / 2;

  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 2;

  ctx.beginPath();
  ctx.arc(r, r, r - 6, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.fill();

  ctx.shadowBlur = 0;
  ctx.lineWidth = 5;
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.stroke();

  return c.toDataURL("image/png");
}

function setupPopulationClustering() {
  popSource.clustering.enabled = true;
  popSource.clustering.pixelRange = CLUSTER_PIXEL_RANGE;
  popSource.clustering.minimumClusterSize = CLUSTER_MIN_SIZE;

  popSource.clustering.clusterEvent.addEventListener((clusteredEntities, cluster) => {
    // Reset visibility once per frame (so unclustered points come back)
    const frame = viewer.scene.frameState.frameNumber;
    if (frame !== _lastResetFrame) {
      _lastResetFrame = frame;
      for (const e of popSource.entities.values) {
        if (e.billboard) e.billboard.show = true;
        if (e.label) e.label.show = true;
        if (e.point) e.point.show = true;
      }
    }

    // Sum population
    let totalPop = 0;
    for (const e of clusteredEntities) {
      const p = e.properties?.population
        ? e.properties.population.getValue()
        : 0;
      totalPop += Number(p) || 0;

      // Hide originals so they don't "fight" the cluster
      if (e.billboard) e.billboard.show = false;
      if (e.label) e.label.show = false;
      if (e.point) e.point.show = false;
    }

    if (!_bubbleImg) _bubbleImg = makeBubbleImage(96);

    cluster.billboard.show = true;
    cluster.billboard.image = _bubbleImg;
    cluster.billboard.verticalOrigin = Cesium.VerticalOrigin.CENTER;
    cluster.billboard.disableDepthTestDistance = Number.POSITIVE_INFINITY;

    const s = Cesium.Math.clamp(
      1.0 + Math.log10(Math.max(totalPop, 10)) * 0.18,
      1.0,
      2.2
    );
    cluster.billboard.width = 34 * s;
    cluster.billboard.height = 34 * s;

    // cluster label just population total
    cluster.label.show = true;
    cluster.label.text = fmtInt(totalPop);
    cluster.label.font = "bold 18px sans-serif";
    cluster.label.fillColor = Cesium.Color.WHITE;
    cluster.label.outlineColor = Cesium.Color.BLACK;
    cluster.label.outlineWidth = 6;
    cluster.label.showBackground = false;
    cluster.label.disableDepthTestDistance = Number.POSITIVE_INFINITY;
  });
}

// =============================================================
// BUILD POINTS (latest-year pop row + coords from any row)
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

  const headers = rows[0].map((h) =>
    String(h).replace("\ufeff", "").trim().toLowerCase()
  );

  const idxCustomerId = headers.indexOf("customer id");
  const idxCustomerName = headers.indexOf("customer name");
  const idxCoordinates = headers.indexOf("coordinates");

  // your two important columns
  const idxLatestFlag = headers.indexOf("is this row the latest year for that customer?");
  const idxPopLatest = headers.indexOf("population (latest year only)");
  const idxPop = headers.indexOf("population");

  if (idxCustomerId === -1 || idxCustomerName === -1 || idxCoordinates === -1) {
    console.error("CSV missing required columns. Found headers:", headers);
    return;
  }
  if (idxLatestFlag === -1) {
    console.error('CSV missing: "Is this row the latest year for that customer?"');
    return;
  }

  // Pass 1: collect best coords per Customer ID (from ANY row that has coords)
  const coordsById = new Map(); // id -> {lat, lon}
  const nameById = new Map();   // id -> name (latest non-empty)

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const rawId = r[idxCustomerId];
    const idNum = toNum(rawId);
    const id = (idNum != null ? String(idNum) : String(rawId || "").trim());
    if (!id) continue;

    const nm = String(r[idxCustomerName] || "").trim();
    if (nm) nameById.set(id, nm);

    const coord = parseCoordinatesLatLon(r[idxCoordinates]);
    if (coord && !coordsById.has(id)) {
      coordsById.set(id, coord);
    }
  }

  // Pass 2: latest-year rows define population (MUST be on latest-year row)
  const latestRowById = new Map(); // id -> { population, name }
  let missingCoordsForLatest = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const rawId = r[idxCustomerId];
    const idNum = toNum(rawId);
    const id = (idNum != null ? String(idNum) : String(rawId || "").trim());
    if (!id) continue;

    const isLatest = toBool(r[idxLatestFlag]);
    if (!isLatest) continue;

    const name = String(r[idxCustomerName] || nameById.get(id) || `Customer ${id}`).trim();

    // population from "Population (Latest Year Only)" if present else "Population"
    const popA = idxPopLatest !== -1 ? toNum(r[idxPopLatest]) : null;
    const popB = idxPop !== -1 ? toNum(r[idxPop]) : null;
    const population = (popA != null ? popA : (popB != null ? popB : 0));

    latestRowById.set(id, { name, population });

    if (!coordsById.has(id)) missingCoordsForLatest++;
  }

  // Build entities only for customers that have a latest-year row AND coords
  for (const [id, latest] of latestRowById.entries()) {
    const coord = coordsById.get(id);
    if (!coord) continue;

    const { lat, lon } = coord;
    const pop = latest.population || 0;

    // Scale point by population (log scale so big schools don't crush small ones)
    const size = Cesium.Math.clamp(8 + Math.log10(Math.max(pop, 1)) * 6, 8, 28);

    const labelText = `${latest.name}\n${fmtInt(pop)}`;

    const entity = popSource.entities.add({
      name: latest.name,
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
      properties: {
        customerId: id,
        population: pop,
      },

      point: {
        pixelSize: size,
        color: Cesium.Color.YELLOW,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 2.0e7),
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
        text: labelText, // name ABOVE number
        font: "bold 18px sans-serif",
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 6,
        showBackground: true,
        backgroundColor: new Cesium.Color(0, 0, 0, 0.55),
        pixelOffset: new Cesium.Cartesian2(0, -55),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,

        // Show labels only when closer (keeps zoomed-out clean)
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 120_000),
      },
    });

    entities.push(entity);
    siteItems.push({
      name: latest.name,
      customerId: id,
      lat,
      lon,
      population: pop,
      entity,
    });
  }

  console.log(`Loaded ${entities.length} mapped customers with latest-year population.`);
  if (missingCoordsForLatest > 0) {
    console.warn(`Latest-year rows missing coords (fixed by borrowing coords when possible). Still missing coords for ${missingCoordsForLatest} customers.`);
  }
}

// =============================================================
// SIDEBAR UI
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
    row.innerHTML = `
      <div>${s.name}</div>
      <div class="siteSub">ID: ${s.customerId} • Pop: ${fmtInt(s.population)}</div>
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
// CLICK / UNLOCK HANDLERS
// =============================================================

// Disable Cesium default dblclick zoom
viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(
  Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK
);

// Chrome hard-unlock
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
// Floating controls (tour button)
// =============================================================
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

function updateTourButton() {
  const btn = document.getElementById("fcTourBtn");
  if (!btn) return;
  btn.textContent = autoAdvance ? "❚❚" : "▶";
  btn.setAttribute("aria-label", autoAdvance ? "Pause auto tour" : "Start auto tour");
}

(function wireFloatingControls() {
  const tourBtn = document.getElementById("fcTourBtn");
  if (!tourBtn) return;

  tourBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleAutoTour();
  });

  updateTourButton();
})();

// =============================================================
// START
// =============================================================
(async function init() {
  setupPopulationClustering();
  await buildEntitiesFromCSV();

  console.log("entities:", entities.length, "popSource:", popSource.entities.values.length);

  wireSearchBox();
  renderSiteList();

  if (entities.length === 0) {
    console.warn("No mapped customers found (latest-year row + coords).");
    return;
  }

  // Start the camera somewhere sane immediately
  activeIndex = 0;
  await zoomDownFlat();

  runTourGuarded();
})();
