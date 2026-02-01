//checkpoint comment
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
// - Keep latest Year with valid coordinates
// =============================================================

const entities = [];
const siteItems = []; // { name, customerId, lat, lon, entity }

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

    if (!prev) {
      bestByCustomer.set(customerId, { name, year, coord });
      continue;
    }

    // If year exists, keep the newer record
    if (year != null && (prev.year == null || year > prev.year)) {
      bestByCustomer.set(customerId, { name, year, coord });
    }
  }

  // Build Cesium entities + sidebar items
  for (const [customerId, item] of bestByCustomer.entries()) {
    const { lat, lon } = item.coord;

    // IMPORTANT SWAP:
    // CSV gives LAT, LON
    // Cesium needs LON, LAT
    const entity = viewer.entities.add({
      name: item.name,
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
      point: {
        pixelSize: 10,
        color: Cesium.Color.YELLOW,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });

    entities.push(entity);
    siteItems.push({ name: item.name, customerId, lat, lon, entity });
  }

  console.log(`Loaded ${entities.length} unique sites from sites.csv`);
}

// =============================================================
// KNOBS YOU CARE ABOUT (KEEPING YOUR UPDATED VALUES)
// =============================================================

// Camera distances
const overviewRangeMeters = 2550000; // how far OUT between sites (Uganda view)
const siteRangeMeters = 1200; // how close IN at the site

// Travel behavior
const travelSeconds = 1.5; // "move above next site" + "zoom out"
const zoomInSeconds = 2.0; // zooming down flat
const tiltSeconds = 1.6; // how fast it tilts into orbit pitch

// Orbit behavior (ONLY while holding at the site)
const orbitPitchDeg = -45; // the tilt angle once at the site
const orbitSpeedDegPerSec = 8; // rotation speed at the site
const holdSeconds = 3; // how long to rotate at each site

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
    durationSec: travelSeconds / 2,
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
// SIDEBAR UI (list + search + click-to-fly)
// =============================================================

function setActiveIndexFromEntity(entity) {
  const idx = entities.indexOf(entity);
  if (idx !== -1) activeIndex = idx;
}

// Ensure viewer canvas can receive keyboard focus
const canvas = viewer.scene.canvas;
canvas.setAttribute("tabindex", "0");
canvas.focus();

// Force keyboard focus back to Cesium after sidebar interactions
function forceCanvasFocus() {
  const input = document.getElementById("siteSearch");
  if (input) input.blur();
  canvas.focus();
}

function flyToSite(entity) {
  autoAdvance = false;
  orbit = false;

  setActiveIndexFromEntity(entity);
  forceCanvasFocus();

  const pos = entity.position.getValue(Cesium.JulianDate.now());

  viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(pos, 1.0), {
    duration: 1.8,
    offset: new Cesium.HeadingPitchRange(
      Cesium.Math.toRadians(0),
      Cesium.Math.toRadians(flatPitchDeg),
      siteRangeMeters
    ),
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
    row.addEventListener("click", () => flyToSite(s.entity));
    listEl.appendChild(row);
  });
}

function wireSearchBox() {
  const input = document.getElementById("siteSearch");
  if (!input) return;
  input.addEventListener("input", () => renderSiteList(input.value));
}

// =============================================================
// CHROME-SAFE "DOUBLE CLICK" + VISUAL HINT
// - Chrome sometimes drops LEFT_DOUBLE_CLICK events.
// - Use LEFT_CLICK + timing so it works everywhere.
// - Show a quick hint overlay.
// =============================================================

// Disable Cesium's default double click zoom
viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(
  Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK
);

// --- Hint overlay (created dynamically, no index.html changes) ---
let dblHintTimeout = null;

function ensureDblHintEl() {
  let el = document.getElementById("dblClickHint");
  if (el) return el;

  el = document.createElement("div");
  el.id = "dblClickHint";
  el.textContent = "Tip: Double click a site marker to zoom";

  el.style.position = "absolute";
  el.style.right = "12px";
  el.style.top = "12px";
  el.style.zIndex = "30";
  el.style.maxWidth = "320px";
  el.style.padding = "10px 12px";
  el.style.borderRadius = "12px";
  el.style.background = "rgba(0,0,0,0.72)";
  el.style.color = "white";
  el.style.fontFamily =
    "system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  el.style.fontSize = "13px";
  el.style.lineHeight = "1.35";
  el.style.pointerEvents = "none";
  el.style.opacity = "0";
  el.style.transition = "opacity 250ms ease";

  document.body.appendChild(el);
  return el;
}

function showDblHint(ms = 4500) {
  const el = ensureDblHintEl();
  if (dblHintTimeout) clearTimeout(dblHintTimeout);
  el.style.opacity = "1";
  dblHintTimeout = setTimeout(() => {
    el.style.opacity = "0";
  }, ms);
}

// Show once on load
showDblHint(5500);

// Manual double-click detector
let lastClickAt = 0;
const DOUBLE_CLICK_MS = 320;

const safeClickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

safeClickHandler.setInputAction((movement) => {
  const now = performance.now();
  const isDouble = now - lastClickAt < DOUBLE_CLICK_MS;
  lastClickAt = now;

  if (!isDouble) {
    const maybePicked = viewer.scene.pick(movement.position);
    if (maybePicked && maybePicked.id && maybePicked.id.position) {
      showDblHint(1800);
    }
    return;
  }

  const picked = viewer.scene.pick(movement.position);
  if (!picked || !picked.id || !picked.id.position) return;

  flyToSite(picked.id);
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

// =============================================================
// HARD STOP on any real user interaction (Chrome-safe)
// Stops auto tour + orbit when user drags/zooms/etc.
// =============================================================
function stopAutoAndGiveControl() {
  autoAdvance = false;
  orbit = false;
  viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  forceCanvasFocus();
}

const uiStopHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

// Drag start
uiStopHandler.setInputAction(stopAutoAndGiveControl, Cesium.ScreenSpaceEventType.LEFT_DOWN);
uiStopHandler.setInputAction(stopAutoAndGiveControl, Cesium.ScreenSpaceEventType.MIDDLE_DOWN);
uiStopHandler.setInputAction(stopAutoAndGiveControl, Cesium.ScreenSpaceEventType.RIGHT_DOWN);

// Touch / trackpad gestures
uiStopHandler.setInputAction(stopAutoAndGiveControl, Cesium.ScreenSpaceEventType.PINCH_START);

// Zoom wheel
uiStopHandler.setInputAction(stopAutoAndGiveControl, Cesium.ScreenSpaceEventType.WHEEL);

// =============================================================
// START (wait for CSV to load first)
// =============================================================
(async function init() {
  await buildEntitiesFromCSV();

  wireSearchBox();
  renderSiteList();

  if (entities.length === 0) {
    console.warn("No sites loaded from sites.csv; tour not started.");
    return;
  }

  runTour();
})();

// =============================================================
// KEYBOARD CONTROLS (capture mode so Chrome can’t swallow it)
// =============================================================
window.addEventListener(
  "keydown",
  async (e) => {
    const active = document.activeElement;
    const isSearchFocused = active && active.id === "siteSearch";

    const k = e.key.toLowerCase();
    const isShortcut = k === "r" || k === "t" || k === "n" || k === "p" || k === "h";

    // If search is focused:
    // - allow typing
    // - but still allow shortcuts
    if (isSearchFocused && !isShortcut) return;

    // If shortcut pressed while search focused: blur so controls work
    if (isSearchFocused && isShortcut) {
      active.blur();
      forceCanvasFocus();
    }

    // If any other input/textarea focused, don't hijack (except our shortcuts)
    const tag = active ? active.tagName : "";
    if ((tag === "INPUT" || tag === "TEXTAREA") && !isShortcut) return;

    if (k === "r") {
      autoAdvance = false;
      orbit = false;
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
      activeIndex = (activeIndex + 1) % entities.length;
      await goAboveSiteFlat();
      await zoomDownFlat();
      e.preventDefault();
      return;
    }

    if (k === "p") {
      autoAdvance = false;
      orbit = false;
      activeIndex = (activeIndex - 1 + entities.length) % entities.length;
      await goAboveSiteFlat();
      await zoomDownFlat();
      e.preventDefault();
      return;
    }

    if (k === "t") {
      autoAdvance = !autoAdvance;
      orbit = false;
      if (autoAdvance) runTour();
      e.preventDefault();
      return;
    }

    // If you have a help panel in index.html with id="controlsHelp"
    // and CSS class ".controlsHelpHidden { display:none; }"
    if (k === "h") {
      const help = document.getElementById("controlsHelp");
      if (help) help.classList.toggle("controlsHelpHidden");
      e.preventDefault();
      return;
    }
  },
  true // capture mode (critical)
);
