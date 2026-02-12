// =============================================================
// FULL WORKING SCRIPT
// + CUSTOM SCREEN-SPACE CLUSTERING (NO OVERLAPPING BUBBLES)
// + Bubbles merge if they'd touch/overlap (based on pixel radii)
// + Cluster bubble CENTER TEXT (population + site count) visible from FAR away
// + Individual sites keep CUSTOMER NAME + population label (near only)
// + HARD RULE: clustering OFF at/under noClusterAtOrBelowMeters
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

const flatPitchDeg = -90;

let autoAdvance = true;

// --- HARD RULE: no clustering at/under this camera height ---
const noClusterAtOrBelowMeters = 5000;

// --- Custom clustering rules ---
const bubblePaddingPx = 10; // extra space so they don't even "touch"
const maxMergePasses = 6;  // merge iterations to fully resolve overlaps

// --- Bubble sizing (SNAPPED) ---
const clusterSizeBuckets = [18, 26, 34, 44, 56, 70, 86, 104];
const clusterSizeByPopulation = true;
const showClusterSiteCount = true;

// --- Cluster center text visibility ---
const clusterTextNear = 10_000;
const clusterTextFar = 10_000_000;
const clusterTextFarAlpha = 0.85;

// --- Site label fade (near only) ---
const siteLabelNear = 0;      // visible at 1200m
const siteLabelFar = 80_000;
const siteLabelFarAlpha = 0.0;

// =============================================================
// DATA + STATE
// =============================================================
const entities = []; // used for tour targets
const siteItems = []; // sidebar list

let activeIndex = 0;
let orbit = false;
let headingDeg = 0;
let lastPerf = performance.now();
let isFlying = false;
let tourRunId = 0;

// Data sources
const sitesDS = new Cesium.CustomDataSource("sites");     // individual sites
const clustersDS = new Cesium.CustomDataSource("clusters"); // rendered clusters
viewer.dataSources.add(sitesDS);
viewer.dataSources.add(clustersDS);

// IMPORTANT: disable Cesium built-in clustering entirely
sitesDS.clustering.enabled = false;

// Store references to the actual site entities (for clustering)
const siteEntities = []; // { entity, pop, id, name }

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

function clusterBubbleSizeFrom(sumPop, count) {
  let rawSize;
  if (clusterSizeByPopulation) {
    rawSize = 16 + Math.log10(Math.max(sumPop, 1)) * 18;
  } else {
    rawSize = 18 + Math.sqrt(count) * 12;
  }
  return pickBucketSize(rawSize);
}

// =============================================================
// CUSTOM CLUSTERING (NO OVERLAP)
// =============================================================
function unionFind(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  return { parent, find, union };
}

function buildClustersFromNodes(nodes, getRadiusFn) {
  const n = nodes.length;
  const uf = unionFind(n);

  for (let i = 0; i < n; i++) {
    const a = nodes[i];
    const ra = getRadiusFn(a);

    for (let j = i + 1; j < n; j++) {
      const b = nodes[j];
      const rb = getRadiusFn(b);

      const dx = a.sx - b.sx;
      const dy = a.sy - b.sy;
      const d = Math.sqrt(dx * dx + dy * dy);

      if (d <= ra + rb + bubblePaddingPx) {
        uf.union(i, j);
      }
    }
  }

  const groups = new Map(); // root -> [idx...]
  for (let i = 0; i < n; i++) {
    const r = uf.find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }

  return Array.from(groups.values()).map((idxs) => idxs.map((i) => nodes[i]));
}

function weightedAverageCartesian(cartesians, weights) {
  let x = 0, y = 0, z = 0, wsum = 0;
  for (let i = 0; i < cartesians.length; i++) {
    const w = weights[i];
    x += cartesians[i].x * w;
    y += cartesians[i].y * w;
    z += cartesians[i].z * w;
    wsum += w;
  }
  if (wsum === 0) return cartesians[0];
  return new Cesium.Cartesian3(x / wsum, y / wsum, z / wsum);
}

function updateClusters() {
  const height = viewer.camera.positionCartographic.height;

  // HARD OFF close-in: show smallest dots
  if (height <= noClusterAtOrBelowMeters) {
    clustersDS.entities.removeAll();
    for (const se of siteEntities) {
      se.entity.show = true;
    }
    return;
  }

  // Build nodes in screen space
  const now = Cesium.JulianDate.now();
  const scene = viewer.scene;
  const ellipsoid = scene.globe.ellipsoid;

  const nodes = [];

  for (const se of siteEntities) {
    const e = se.entity;
    const pos = e.position?.getValue(now);
    if (!pos) continue;

    // Skip behind globe / not on screen
    const windowPos = Cesium.SceneTransforms.wgs84ToWindowCoordinates(scene, pos);
    if (!windowPos) continue;

    // Base radius: single dot radius in pixels
    const basePx = e.point?.pixelSize?.getValue?.(now) ?? e.point?.pixelSize ?? 10;
    const baseRadius = Math.max(3, Number(basePx) / 2);

    nodes.push({
      entity: e,
      pos,
      sx: windowPos.x,
      sy: windowPos.y,
      pop: se.pop,
      baseRadius,
    });
  }

  // If nothing, clear
  clustersDS.entities.removeAll();
  if (nodes.length === 0) return;

  // Iteratively merge until no overlaps, using cluster radii
  let clusters = nodes.map((n) => [n]);

  for (let pass = 0; pass < maxMergePasses; pass++) {
    // Compute each cluster's radius from its population/count
    const clusterRadius = new Map(); // clusterIndex -> radiusPx
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[i];
      const sumPop = c.reduce((s, n) => s + (Number(n.pop) || 0), 0);
      const px = clusterBubbleSizeFrom(sumPop, c.length);
      clusterRadius.set(i, px / 2);
    }

    // Create temporary "super nodes" for overlap testing between clusters
    const superNodes = clusters.map((c, idx) => {
      // center in screen space (average)
      const cx = c.reduce((s, n) => s + n.sx, 0) / c.length;
      const cy = c.reduce((s, n) => s + n.sy, 0) / c.length;
      return {
        idx,
        sx: cx,
        sy: cy,
        radius: clusterRadius.get(idx),
        members: c,
      };
    });

    // Merge any overlapping super nodes
    const merged = buildClustersFromNodes(
      superNodes,
      (sn) => sn.radius
    );

    // If stable (no change), break
    if (merged.length === clusters.length) break;

    // Rebuild clusters from merged superNodes
    clusters = merged.map((group) => {
      const allMembers = [];
      for (const sn of group) {
        allMembers.push(...sn.members);
      }
      return allMembers;
    });
  }

  // Now render: hide individual sites that are in a cluster of size > 1
  // Show individual sites that are alone (size 1) so you still see small dots
  clustersDS.entities.removeAll();

  // Default show all, then hide those clustered
  for (const se of siteEntities) se.entity.show = true;

  for (const c of clusters) {
    if (c.length <= 1) continue;

    // Hide member entities
    for (const n of c) n.entity.show = false;

    const sumPop = c.reduce((s, n) => s + (Number(n.pop) || 0), 0);
    const bubblePx = clusterBubbleSizeFrom(sumPop, c.length);

    // Cluster world position: weighted avg by population (fallback weight=1)
    const cartesians = c.map((n) => n.pos);
    const weights = c.map((n) => Math.max(1, Number(n.pop) || 1));
    const clusterPos = weightedAverageCartesian(cartesians, weights);

    clustersDS.entities.add({
      position: clusterPos,

      point: {
        pixelSize: bubblePx,
        color: Cesium.Color.YELLOW.withAlpha(0.88),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },

      label: {
        show: true,
        text:
          `Pop: ${fmtInt(sumPop)}` +
          (showClusterSiteCount ? `\nSites: ${c.length}` : ""),

        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        pixelOffset: Cesium.Cartesian2.ZERO,
        eyeOffset: Cesium.Cartesian3.ZERO,
        heightReference: Cesium.HeightReference.NONE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,

        showBackground: false,
        font: clusterFontForBubble(bubblePx),
        fillColor: Cesium.Color.BLACK,
        outlineWidth: 0,

        translucencyByDistance: new Cesium.NearFarScalar(
          clusterTextNear,
          1.0,
          clusterTextFar,
          clusterTextFarAlpha
        ),
        scaleByDistance: new Cesium.NearFarScalar(
          clusterTextNear,
          1.0,
          clusterTextFar,
          1.0
        ),
      },
    });
  }
}

// Debounce cluster updates during camera motion
let clusterUpdateQueued = false;
function requestClusterUpdate() {
  if (clusterUpdateQueued) return;
  clusterUpdateQueued = true;

  requestAnimationFrame(() => {
    clusterUpdateQueued = false;
    updateClusters();
  });
}

// Recluster whenever camera changes
viewer.camera.changed.addEventListener(() => {
  requestClusterUpdate();
});

// Also update after render once (good for first frame)
viewer.scene.postRender.addEventListener(() => {
  // lightweight: only run if queued
  if (clusterUpdateQueued) return;
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
  clustersDS.entities.removeAll();
  entities.length = 0;
  siteItems.length = 0;
  siteEntities.length = 0;

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

    siteEntities.push({ entity, pop, id, name: customerName });

    plotted++;
  }

  console.log("Plotted installed sites:", plotted);

  // Run first clustering pass
  updateClusters();
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
    complete: () => {
      canvas.focus();
      // re-evaluate clusters after flight
      updateClusters();
    },
    cancel: () => {
      updateClusters();
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

      updateClusters();
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

      updateClusters();
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

      updateClusters();
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
