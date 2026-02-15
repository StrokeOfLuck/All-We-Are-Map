// =============================================================
// FULL WORKING SCRIPT
// Data format: Impact_Map_Export - Sheet1.csv
// Features:
// 1) Filters to Installed systems only
// 2) Joins Customer -> Location -> Population (latest year)
// 3) Plots sites
// 4) Clustering into bigger bubbles when zoomed out
//    Cluster bubble shows: count of sites + total population
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

// =============================================================
// DATA + STATE
// =============================================================
const entities = [];
const siteItems = []; // { name, customerId, lat, lon, population, entity }

let activeIndex = 0;
let orbit = false;
let headingDeg = 0;
let lastPerf = performance.now();
let isFlying = false;

let tourRunId = 0;

// =============================================================
// CLUSTERING (NEW)
// Cesium clustering works on a DataSource, not viewer.entities
// =============================================================
const sitesDS = new Cesium.CustomDataSource("sites");
viewer.dataSources.add(sitesDS);

sitesDS.clustering.enabled = true;
sitesDS.clustering.minimumClusterSize = 2;
sitesDS.clustering.pixelRange = 80;

// Simple SVG bubble so you do not need an image file in your repo
function makeClusterBubbleDataUrl({
  diameter = 64,
  fill = "rgba(255, 215, 0, 0.95)",
  stroke = "rgba(0, 0, 0, 0.85)",
  strokeWidth = 4,
  shadow = true,
} = {}) {
  const r = diameter / 2;
  const shadowFilter = shadow
    ? `<filter id="s" x="-50%" y="-50%" width="200%" height="200%">
         <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="rgba(0,0,0,0.35)"/>
       </filter>`
    : "";

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${diameter}" height="${diameter}" viewBox="0 0 ${diameter} ${diameter}">
      ${shadowFilter}
      <circle cx="${r}" cy="${r}" r="${r - strokeWidth}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" ${shadow ? 'filter="url(#s)"' : ""}/>
    </svg>
  `.trim();

  return "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg);
}

const CLUSTER_BUBBLE_URL = makeClusterBubbleDataUrl({ diameter: 64 });

// Cluster label shows count and total population
sitesDS.clustering.clusterEvent.addEventListener((clusteredEntities, cluster) => {
  const count = clusteredEntities.length;

  let popSum = 0;
  const now = Cesium.JulianDate.now();
  for (const e of clusteredEntities) {
    const p = e.properties?.population?.getValue?.(now);
    if (Number.isFinite(p)) popSum += p;
  }

  cluster.point.show = false;

  cluster.billboard.show = true;
  cluster.billboard.image = CLUSTER_BUBBLE_URL;
  cluster.billboard.width = 56;
  cluster.billboard.height = 56;
  cluster.billboard.verticalOrigin = Cesium.VerticalOrigin.CENTER;
  cluster.billboard.disableDepthTestDistance = Number.POSITIVE_INFINITY;

  cluster.label.show = true;
  cluster.label.font = "bold 16px sans-serif";
  cluster.label.fillColor = Cesium.Color.WHITE;
  cluster.label.outlineColor = Cesium.Color.BLACK;
  cluster.label.outlineWidth = 6;
  cluster.label.showBackground = true;
  cluster.label.backgroundColor = new Cesium.Color(0, 0, 0, 0.35);
  cluster.label.disableDepthTestDistance = Number.POSITIVE_INFINITY;

  cluster.label.text = `${count}\n${fmtInt(popSum)}`;

  // Scale bubble a bit with count
  const s = clamp(1.0 + Math.log10(Math.max(count, 1)) * 0.25, 1.0, 2.2);
  cluster.billboard.scale = s;
  cluster.label.scale = s;
});

// Ramp clustering strength with altitude so zoomed out becomes one mega cluster
function updateClusterStrength() {
  const h = viewer.camera.positionCartographic.height;

  const nearH = 50_000;
  const farH = 2_500_000;

  const t = clamp((h - nearH) / (farH - nearH), 0, 1);

  // pixelRange ramps from 25 (mostly separate) to 450 (heavy merge)
  sitesDS.clustering.pixelRange = Math.round(25 + t * 425);
}

viewer.scene.postRender.addEventListener(updateClusterStrength);

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

// =============================================================
// MAIN (Impact_Map_Export_3.0 format)
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

  // Layout indices (0-based)
  // A–F Installed Systems table
  const IDX_INST_CUST_ID = 0; // A
  const IDX_INST_STATUS = 4; // E ("Installed")

  // I–L Population table
  const IDX_POP_CUST_ID = 8; // I
  const IDX_POP_YEAR = 9; // J
  const IDX_POP_VALUE = 10; // K

  // O–Q Locations table
  const IDX_LOC_ID = 14; // O
  const IDX_LOC_COORDS = 16; // Q

  // S–V Customers table
  const IDX_CUST_ID = 18; // S
  const IDX_CUST_NAME = 19; // T
  const IDX_CUST_LOC_ID = 21; // V

  // Reset
  sitesDS.entities.removeAll();
  entities.length = 0;
  siteItems.length = 0;

  // -------------------------------------------------------------
  // PASS 0: Collect Installed Customer IDs
  // -------------------------------------------------------------
  const installedIds = new Set();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];

    const custIdNum = toNum(row[IDX_INST_CUST_ID]);
    if (custIdNum == null) continue;

    const status = String(row[IDX_INST_STATUS] ?? "").trim().toLowerCase();
    if (status !== "installed") continue;

    installedIds.add(String(Math.trunc(custIdNum)));
  }

  console.log("Installed customer IDs:", installedIds.size);

  // -------------------------------------------------------------
  // PASS 1: Latest population per Customer ID
  // -------------------------------------------------------------
  const popById = new Map(); // id -> {year, pop}

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

  console.log("Population IDs with data:", popById.size);

  // -------------------------------------------------------------
  // PASS 2: Coordinates by Loc ID
  // -------------------------------------------------------------
  const coordsByLocId = new Map(); // locId -> {lat, lon}

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];

    const locIdNum = toNum(row[IDX_LOC_ID]);
    if (locIdNum == null) continue;

    const coord = parseCoordinatesLatLon(row[IDX_LOC_COORDS]);
    if (!coord) continue;

    const locId = String(Math.trunc(locIdNum));
    coordsByLocId.set(locId, coord);
  }

  console.log("Locations with coords:", coordsByLocId.size);

  // -------------------------------------------------------------
  // PASS 3: Customer name + locId by Customer ID
  // -------------------------------------------------------------
  const customerById = new Map(); // id -> {name, locId}

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];

    const idNum = toNum(row[IDX_CUST_ID]);
    if (idNum == null) continue;

    const name = String(row[IDX_CUST_NAME] ?? "").trim();
    const locIdNum = toNum(row[IDX_CUST_LOC_ID]);
    if (!name || locIdNum == null) continue;

    const id = String(Math.trunc(idNum));
    const locId = String(Math.trunc(locIdNum));

    if (!customerById.has(id)) {
      customerById.set(id, { name, locId });
    }
  }

  console.log("Customers with name+loc:", customerById.size);

  // -------------------------------------------------------------
  // PASS 4: Plot ONLY installed customers with coords + population
  // -------------------------------------------------------------
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
    if (!popRec || popRec.pop == null) {
      missingPop++;
      continue;
    }

    const pop = popRec.pop;
    if (pop <= 0) continue;

    const { lat, lon } = coord;

    const labelText = `${cust.name}\nPopulation served: ${fmtInt(pop)}`;

    const entity = sitesDS.entities.add({
      name: cust.name,
      position: Cesium.Cartesian3.fromDegrees(lon, lat),

      properties: {
        customerId: id,
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

  console.log("Plotted installed sites:", plotted);
  console.log("Missing customer row:", missingCustomer);
  console.log("Missing coords:", missingCoords);
  console.log("Missing population:", missingPop);
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
