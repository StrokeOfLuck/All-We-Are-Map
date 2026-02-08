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

// ✅ Sharp labels/billboards on high-DPI screens (must be AFTER viewer is created)
viewer.resolutionScale = window.devicePixelRatio;

// Canvas reference + keyboard focus
const canvas = viewer.scene.canvas;
canvas.setAttribute("tabindex", "0");
canvas.focus();

// -------------------------------
// Basemap (pick ONE)
// -------------------------------

/*
// FREE backup basemap (no tokens)
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
// KNOBS YOU CARE ABOUT
// =============================================================

// Camera distances
const overviewRangeMeters = 1300000; // how far OUT between sites
const siteRangeMeters = 1200; // how close IN at the site

// Travel behavior
const travelSeconds = 1.5; // "move above next site" + "zoom out"
const zoomInSeconds = 2.0; // zooming down flat
const tiltSeconds = 1.6; // tilt into orbit pitch

// Orbit behavior (ONLY while holding at the site)
const orbitPitchDeg = -45;
const orbitSpeedDegPerSec = 8;
const holdSeconds = 3;

// Flat travel orientation
const flatHeadingDeg = 0;
const flatPitchDeg = -90;

// Auto tour
let autoAdvance = true;

// =============================================================
// DATA + STATE
// =============================================================
const entities = [];
const siteItems = []; // { name, customerId, lat, lon, entity }

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

// HARD unlock (breaks Cesium lookAt lock in Chrome)
function hardUnlockCamera() {
  autoAdvance = false;
  orbit = false;

  // invalidate any running tour loop
  tourRunId++;

  try {
    viewer.camera.cancelFlight();
  } catch (_) {}

  viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  canvas.focus();

  // ✅ keep UI in sync
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

// Travel flat above site
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

// Zoom down flat
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

// Tilt into orbit pitch (no rotation yet)
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

// Tilt back flat
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
// ORBIT LOOP (ONLY when orbit === true)
// =============================================================
viewer.clock.onTick.addEventListener(() => {
  if (!orbit) return;
  if (isFlying) return;

  const now = performance.now();
  const dt = Math.min((now - lastPerf) / 1000, 0.05);
  lastPerf = now;

  headingDeg += orbitSpeedDegPerSec * dt;

  // Orbit uses lookAt, which "locks" camera unless we hardUnlock on user input
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
// TOUR LOOP
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
// POPULATION CLUSTERING (zoom-out = combined bubble with summed population)
// Put this block AFTER buildEntitiesFromCSV() is defined,
// and BEFORE init() runs (or call setupPopulationClustering() inside init()
// right after buildEntitiesFromCSV()).
//
// What it does:
// - Creates a CustomDataSource so Cesium's built-in clustering works
// - Copies your entities into that data source
// - When clustered, sums entity.properties.population
// - Shows a single "bubble" label with the summed population
//
// NOTE:
// This is "combine when zoomed out" automatically.
// When you zoom in, clusters naturally split back into the original points.
// =============================================================

const popSource = new Cesium.CustomDataSource("populationSites");

// clustering knobs
const CLUSTER_PIXEL_RANGE = 55;
const CLUSTER_MIN_SIZE = 2;

function fmtInt(n) {
  const x = Math.round(Number(n) || 0);
  return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

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
    // reset visibility once per frame
    const frame = viewer.scene.frameState.frameNumber;
    if (frame !== _lastResetFrame) {
      _lastResetFrame = frame;
      for (const e of popSource.entities.values) {
        if (e.point) e.point.show = true;
        if (e.billboard) e.billboard.show = true;
        if (e.label) e.label.show = true;
      }
    }

    let totalPop = 0;
    for (const e of clusteredEntities) {
      const p = e.properties && e.properties.population
        ? e.properties.population.getValue()
        : 0;
      totalPop += Number(p) || 0;

      // hide originals so they don’t fight the cluster
      if (e.point) e.point.show = false;
      if (e.billboard) e.billboard.show = false;
      if (e.label) e.label.show = false;
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
// CSV LOADING (no dependencies)
// CSV format:
// - "Coordinates" is "LAT, LON" (backwards for Cesium)
// - Cesium needs fromDegrees(LON, LAT)
// Dedupe: keep latest Year per Customer ID with valid coordinates
// =============================================================
console.log("popSource exists?", !!popSource);
// ---------- CSV parser ----------
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

// ---------- helpers ----------
function toNum(x) {
  if (x == null) return null;
  const s = String(x)
    .replace(/\u00A0/g, " ")
    .trim()
    .replace(/,/g, ""); // allow "1,234.56"
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

// ---------- loader ----------
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
  const idxYear = headers.indexOf("year");
  const idxCoordinates = headers.indexOf("coordinates");
  const idxPopulation = headers.indexOf("population"); // ✅ NEW

  if (idxCoordinates === -1) {
    console.error('CSV missing required column: "Coordinates"');
    console.log("Headers found:", headers);
    return;
  }

  // keep latest Year per Customer ID
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

    // ✅ NEW: read population
    const population =
      idxPopulation !== -1 ? (toNum(r[idxPopulation]) ?? 0) : 0;

    const prev = bestByCustomer.get(customerId);

    if (!prev) {
      bestByCustomer.set(customerId, { name, year, coord, population }); // ✅ NEW
      continue;
    }

    // choose newest year (or first if no year)
    if (year != null && (prev.year == null || year > prev.year)) {
      bestByCustomer.set(customerId, { name, year, coord, population }); // ✅ NEW
    }
  }

  // build entities
  for (const [customerId, item] of bestByCustomer.entries()) {
    const { lat, lon } = item.coord;

    const entity = popSource.entities.add({
      name: item.name,
      position: Cesium.Cartesian3.fromDegrees(lon, lat),

      // ✅ NEW: store population on entity for clustering + UI
      properties: {
        population: item.population,
        customerId: customerId,
      },

      point: {
        pixelSize: 4,
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
        text: item.name,
        font: "20px sans-serif",
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 4,
        showBackground: true,
        backgroundColor: new Cesium.Color(0, 0, 0, 0.6),
        pixelOffset: new Cesium.Cartesian2(0, -36),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      
        // Show names only when closer (prevents fighting clusters)
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 80_000),
      },
    });

    entities.push(entity);

    // ✅ NEW: keep population in siteItems too
    siteItems.push({
      name: item.name,
      customerId,
      lat,
      lon,
      population: item.population,
      entity,
    });
  }

  console.log(`Loaded ${entities.length} unique sites from ${CSV_URL}`);
}


// =============================================================
// SIDEBAR UI
// =============================================================
function flyToSite(entity) {
  autoAdvance = false;
  orbit = false;
  tourRunId++;          // stop any running tour loop
  updateTourButton();

  setActiveIndexFromEntity(entity);

  // Make sure camera is not locked
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
      <div class="siteSub">ID: ${s.customerId}</div>
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
// CHROME-SAFE DOUBLE CLICK (uses LEFT_CLICK timing)
// =============================================================

// Disable Cesium default dblclick zoom (optional)
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
// CHROME HARD-UNLOCK (DOM capture phase)
// Makes click+drag ALWAYS break orbit/tour in Chrome.
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
// KEYBOARD SHORTCUTS (capture mode so UI can't swallow them)
// - Allows typing in search normally, except shortcut keys.
// =============================================================
window.addEventListener(
  "keydown",
  async (e) => {
    const active = document.activeElement;
    const isSearch = active && active.id === "siteSearch";

    const k = e.key.toLowerCase();
    const isShortcut = k === "r" || k === "t" || k === "n" || k === "p" || k === "h";

    // Let typing work in search box unless it's a shortcut
    if (isSearch && !isShortcut) return;

    // If shortcut pressed while search focused, blur search and re-focus canvas
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

      autoAdvance = !autoAdvance;
      if (autoAdvance) runTour();

      e.preventDefault();
      return;
    }
  },
  true
);


// =============================================================
// Floating controls: menu + tour toggle + restart
// =============================================================

// Prevent multiple tour loops from stacking
let tourRunId = 0;

async function runTourGuarded() {
  const myId = ++tourRunId;

  // runTour() is your existing loop. We just guard against stale runs.
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


function toggleAutoTour() {
  autoAdvance = !autoAdvance;

  if (autoAdvance) {
    // kick off tour if turning on
    if (entities.length > 0) runTourGuarded();
  } else {
    orbit = false;
    tourRunId++; // invalidate current run
  }

  updateTourButton();
}

function updateTourButton() {
  const btn = document.getElementById("fcTourBtn");
  if (!btn) return;

  // ⏸ when running, ▶ when paused
  btn.textContent = autoAdvance ? "❚❚" : "▶";
  btn.setAttribute("aria-label", autoAdvance ? "Pause auto tour" : "Start auto tour");
}

(function wireFloatingControls() {
  const sidebar = document.getElementById("sidebar");
  const menuBtn = document.getElementById("fcMenuBtn");
  const tourBtn = document.getElementById("fcTourBtn");

  if (!sidebar || !menuBtn || !tourBtn ) return;

  const mqMobile = window.matchMedia("(max-width: 768px)");

  function isClosed() {
    return sidebar.classList.contains("sidebarClosed");
  }

  function applyInitialSidebarState() {
    // Start CLOSED on all devices
    sidebar.classList.add("sidebarClosed");
    updateMenuButton();
  }
  function updateMenuButton() {
    // show ☰ when closed, ✕ when open
    menuBtn.textContent = isClosed() ? "☰" : "✕";
    menuBtn.setAttribute("aria-label", isClosed() ? "Open locations menu" : "Close locations menu");
  }

  function toggleMenu() {
    sidebar.classList.toggle("sidebarClosed");
    updateMenuButton();
  }

  // menu button always visible
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu();
  });

  // tour buttons always visible
  tourBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleAutoTour();
  });

  // keep sidebar clicks from hitting the map
  sidebar.addEventListener("pointerdown", (e) => e.stopPropagation());
  sidebar.addEventListener("click", (e) => e.stopPropagation());

  // re-apply open/closed rule on rotate/resize
  if (mqMobile.addEventListener) mqMobile.addEventListener("change", applyInitialSidebarState);
  else window.addEventListener("resize", applyInitialSidebarState);

  applyInitialSidebarState();
  updateTourButton();
})();

// =============================================================
// Help box close button (X) - runs once
// =============================================================
(function wireHelpCloseButton() {
  const help = document.getElementById("controlsHelp");
  const closeBtn = document.getElementById("helpCloseBtn");
  if (!help || !closeBtn) return;

  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    help.classList.add("controlsHelpHidden");
  });
})();

// =============================================================
// START
// =============================================================
(async function init() {
  setupPopulationClustering();  // enable clustering
  await buildEntitiesFromCSV(); // create points directly in popSource

  console.log("entities:", entities.length, "popSource:", popSource.entities.values.length);

  wireSearchBox();
  renderSiteList();

  if (entities.length === 0) return;
  runTourGuarded();
})();
