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
// CSV LOADING (Latitude / Longitude already computed in Sheets)
// One row = one customer bubble
// =============================================================
async function buildEntitiesFromCSV() {
  const CSV_URL = "Impact_Map_Export - Sheet1.csv";

  const res = await fetch(CSV_URL);
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

  const idx = (name) => headers.indexOf(name.toLowerCase());

  const idxCustomerId   = idx("customer id");
  const idxCustomerName = idx("customer name");
  const idxLat          = idx("latitude");
  const idxLon          = idx("longitude");

  if (idxLat === -1 || idxLon === -1) {
    console.error('CSV missing required columns: "Latitude" and/or "Longitude"');
    return;
  }

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];

    const lat = toNum(r[idxLat]);
    const lon = toNum(r[idxLon]);
    if (lat == null || lon == null) continue;

    const customerId =
      idxCustomerId !== -1 && String(r[idxCustomerId]).trim()
        ? String(r[idxCustomerId]).trim()
        : `row-${i}`;

    const name =
      idxCustomerName !== -1 && String(r[idxCustomerName]).trim()
        ? String(r[idxCustomerName]).trim()
        : `Customer ${customerId}`;

    const entity = viewer.entities.add({
      name,
      position: Cesium.Cartesian3.fromDegrees(lon, lat),

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
        text: name,
        font: "20px sans-serif",
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 4,
        showBackground: true,
        backgroundColor: new Cesium.Color(0, 0, 0, 0.6),
        pixelOffset: new Cesium.Cartesian2(0, -36),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 250_000),
      },
    });

    entities.push(entity);
    siteItems.push({ name, customerId, lat, lon, entity });
  }

  console.log(`Loaded ${entities.length} customers from ${CSV_URL}`);
}

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
  await buildEntitiesFromCSV();

  wireSearchBox();
  renderSiteList();

  if (entities.length === 0) {
    console.warn("No sites loaded from sites.csv; tour not started.");
    return;
  }

  runTourGuarded();
})();
