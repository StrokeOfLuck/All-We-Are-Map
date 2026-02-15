// =============================================================
// NEW CLUSTERING APPROACH (manual clustering, NO Cesium clustering)
// Data: Impact_Map_Export - Sheet1.csv
//
// Controls you asked for:
// 1) CLUSTER_MODE_MIN_HEIGHT = height where pins -> clusters
// 2) FULL_MERGE_MIN_HEIGHT  = height where EVERYTHING -> 1 bubble
// 3) GRID_*                 = how aggressively clusters merge between those heights
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

viewer.imageryLayers.addImageryProvider(
  new Cesium.UrlTemplateImageryProvider({
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    credit: "Esri World Imagery",
  })
);

const canvas = viewer.scene.canvas;
canvas.setAttribute("tabindex", "0");
canvas.focus();

// =============================================================
// KNOBS (YOUR MERGE CONTROLS)
// =============================================================
const CSV_URL = "Impact_Map_Export - Sheet1.csv";

// Below this height: show individual pins
const CLUSTER_MODE_MIN_HEIGHT = 15_000;

// Above this height: force ONE mega bubble
const FULL_MERGE_MIN_HEIGHT = 3_000_000;

// Between those heights: grid clustering ramps from near -> far grid size
const GRID_DEG_NEAR = 0.15;   // less merging (smaller grid)
const GRID_DEG_FAR  = 2.50;   // more merging (bigger grid)

const GRID_HEIGHT_NEAR = CLUSTER_MODE_MIN_HEIGHT;
const GRID_HEIGHT_FAR  = FULL_MERGE_MIN_HEIGHT;

// Bubble scaling based on count
const CLUSTER_MIN_SCALE = 1.0;
const CLUSTER_MAX_SCALE = 2.2;

// =============================================================
// STATE
// =============================================================
const sites = [];           // canonical dataset: {id,name,lat,lon,pop,locId,year}
const siteEntities = [];    // Cesium entities for individual sites
const clusterEntities = []; // Cesium entities for cluster bubbles

// =============================================================
// UTIL
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

function clearEntities(arr) {
  for (const e of arr) viewer.entities.remove(e);
  arr.length = 0;
}

function bubbleSvgDataUrl(diameter = 72) {
  const r = diameter / 2;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${diameter}" height="${diameter}" viewBox="0 0 ${diameter} ${diameter}">
      <defs>
        <filter id="s" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="rgba(0,0,0,0.35)"/>
        </filter>
      </defs>
      <circle cx="${r}" cy="${r}" r="${r - 4}" fill="rgba(255,215,0,0.95)" stroke="rgba(0,0,0,0.85)" stroke-width="4" filter="url(#s)"/>
    </svg>
  `.trim();
  return "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg);
}
const CLUSTER_BUBBLE = bubbleSvgDataUrl(72);

function gridSizeDegForHeight(h) {
  const t = clamp((h - GRID_HEIGHT_NEAR) / (GRID_HEIGHT_FAR - GRID_HEIGHT_NEAR), 0, 1);
  return lerp(GRID_DEG_NEAR, GRID_DEG_FAR, t);
}

// =============================================================
// DATA LOAD (same joins as your original script)
// =============================================================
async function loadSitesFromCSV() {
  const res = await fetch(encodeURI(CSV_URL));
  if (!res.ok) throw new Error(`Failed to fetch ${CSV_URL}: ${res.status} ${res.statusText}`);

  const text = await res.text();
  const rows = parseCSV(text);
  if (rows.length < 2) return [];

  // Indices (0-based)
  const IDX_INST_CUST_ID = 0;  // A
  const IDX_INST_STATUS  = 4;  // E

  const IDX_POP_CUST_ID  = 8;  // I
  const IDX_POP_YEAR     = 9;  // J
  const IDX_POP_VALUE    = 10; // K

  const IDX_LOC_ID       = 14; // O
  const IDX_LOC_COORDS   = 16; // Q

  const IDX_CUST_ID      = 18; // S
  const IDX_CUST_NAME    = 19; // T
  const IDX_CUST_LOC_ID  = 21; // V

  // Installed IDs
  const installedIds = new Set();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const custIdNum = toNum(row[IDX_INST_CUST_ID]);
    if (custIdNum == null) continue;
    const status = String(row[IDX_INST_STATUS] ?? "").trim().toLowerCase();
    if (status === "installed") installedIds.add(String(Math.trunc(custIdNum)));
  }

  // Latest population
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

  // Coords by locId
  const coordsByLocId = new Map();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const locIdNum = toNum(row[IDX_LOC_ID]);
    if (locIdNum == null) continue;

    const coord = parseCoordinatesLatLon(row[IDX_LOC_COORDS]);
    if (!coord) continue;

    coordsByLocId.set(String(Math.trunc(locIdNum)), coord);
  }

  // Customer by id
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

  // Final sites: installed + has customer row + has coords + has pop
  const out = [];
  for (const id of installedIds) {
    const cust = customerById.get(id);
    if (!cust) continue;

    const coord = coordsByLocId.get(cust.locId);
    if (!coord) continue;

    const popRec = popById.get(id);
    if (!popRec || !Number.isFinite(popRec.pop) || popRec.pop <= 0) continue;

    out.push({
      id,
      name: cust.name,
      lat: coord.lat,
      lon: coord.lon,
      pop: popRec.pop,
      year: popRec.year,
      locId: cust.locId,
    });
  }

  console.log("Loaded sites:", out.length);
  return out;
}

// =============================================================
// RENDER: INDIVIDUAL SITES
// =============================================================
function addSiteEntities() {
  clearEntities(siteEntities);
  clearEntities(clusterEntities);

  for (const s of sites) {
    const labelText = `${s.name}\nPopulation served: ${fmtInt(s.pop)}`;

    const e = viewer.entities.add({
      name: s.name,
      position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat),
      properties: {
        isCluster: false,
        customerId: s.id,
        population: s.pop,
        year: s.year,
        locId: s.locId,
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

    siteEntities.push(e);
  }
}

// =============================================================
// CLUSTER BUILDING
// =============================================================
function buildClusters(gridDeg) {
  const buckets = new Map(); // key -> bucket

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

// =============================================================
// RENDER: GRID CLUSTERS
// =============================================================
function showClusterEntities() {
  clearEntities(siteEntities);
  clearEntities(clusterEntities);

  const h = viewer.camera.positionCartographic.height;
  const gridDeg = gridSizeDegForHeight(h);
  const clusters = buildClusters(gridDeg);

  for (const c of clusters) {
    const s = clamp(
      1.0 + Math.log10(Math.max(c.count, 1)) * 0.35,
      CLUSTER_MIN_SCALE,
      CLUSTER_MAX_SCALE
    );

    const e = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(c.lon, c.lat),
      properties: {
        isCluster: true,
        count: c.count,
        popSum: c.popSum,
      },
      billboard: {
        image: CLUSTER_BUBBLE,
        width: 56,
        height: 56,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scale: s,
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
        scale: s,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        pixelOffset: new Cesium.Cartesian2(0, 0),
      },
    });

    clusterEntities.push(e);
  }
}

// =============================================================
// RENDER: ONE MEGA CLUSTER
// =============================================================
function showOneMegaCluster() {
  clearEntities(siteEntities);
  clearEntities(clusterEntities);

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

  const e = viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(lon, lat),
    properties: { isCluster: true, count, popSum, mega: true },
    billboard: {
      image: CLUSTER_BUBBLE,
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

  clusterEntities.push(e);
}

// =============================================================
// MODE SWITCHING (THIS IS THE MERGE LOGIC)
// =============================================================
function refreshClustersIfNeeded() {
  const h = viewer.camera.positionCartographic.height;

  if (h >= FULL_MERGE_MIN_HEIGHT) {
    showOneMegaCluster();
    return;
  }

  if (h >= CLUSTER_MODE_MIN_HEIGHT) {
    showClusterEntities();
    return;
  }

  addSiteEntities();
}

// Debounce refresh while panning/zooming
let refreshTimer = null;
function requestRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshClustersIfNeeded();
  }, 80);
}

// =============================================================
// CLICK: if cluster clicked, zoom in toward it
// =============================================================
const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
handler.setInputAction((movement) => {
  const picked = viewer.scene.pick(movement.position);
  if (!picked || !picked.id) return;

  const ent = picked.id;
  const now = Cesium.JulianDate.now();
  const isCluster = ent.properties?.isCluster?.getValue?.(now);
  if (!isCluster) return;

  const pos = ent.position.getValue(now);

  viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(pos, 1.0), {
    duration: 0.9,
    offset: new Cesium.HeadingPitchRange(
      Cesium.Math.toRadians(0),
      Cesium.Math.toRadians(-60),
      Math.max(35_000, viewer.camera.positionCartographic.height * 0.35)
    ),
  });
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

// =============================================================
// START
// =============================================================
(async function init() {
  try {
    const loaded = await loadSitesFromCSV();
    sites.length = 0;
    sites.push(...loaded);

    if (sites.length === 0) {
      console.warn("No sites loaded.");
      return;
    }

    // Initial render + zoom
    addSiteEntities();
    viewer.zoomTo(viewer.entities);

    // Refresh on camera motion
    viewer.camera.moveEnd.addEventListener(requestRefresh);
    viewer.camera.changed.addEventListener(requestRefresh);

    // One immediate refresh so it chooses the right mode for your starting view
    refreshClustersIfNeeded();
  } catch (e) {
    console.error(e);
  }
})();
