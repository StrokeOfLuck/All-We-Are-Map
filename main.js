// =============================================================
// FULL WORKING SCRIPT (2-pass, NO SKIPPING COORD SITES)
// + CUSTOM "NO-OVERLAP" CLUSTERING (bubble collision => merge)
// + Cluster bubble CENTER TEXT (population + site count) visible from FAR away
// + Individual sites keep CUSTOMER NAME from CSV + population label (near only)
// + IMPORTANT: At <= noClusterAtOrBelowMeters, clustering is HARD OFF
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

// -----------------------------
// CUSTOM CLUSTERING KNOBS
// -----------------------------

// HARD RULE: no clusters at/under this camera height.
// If you want "no clusters under ~2000", set to 2000.
const noClusterAtOrBelowMeters = 25000;

// Cluster labels visible far away (separate from site labels)
const clusterTextNear = 10_000;
const clusterTextFar = 10_000_000;
const clusterTextFarAlpha = 0.85;

// Bubble style
const clusterBubbleAlpha = 0.88;
const clusterBubbleOutlineWidth = 2;

// Bubble sizing buckets (snapped)
const clusterSizeBuckets = [18, 26, 34, 44, 56, 70, 86, 104];

// Bubble size driver
const clusterSizeByPopulation = true;

// Show "Sites: N" line in clusters
const showClusterSiteCount = true;

// NO-OVERLAP rule: if bubble circles would touch/overlap, merge them
const bubblePaddingPx = 6;

// How often to rebuild clusters while moving
const clusterRebuildThrottleMs = 160;

// If you want clustering to start only after a bit of zoom-out,
// increase this above noClusterAtOrBelowMeters (optional)
const clusterStartMeters = noClusterAtOrBelowMeters;

// Optional: cap rebuild cost (safety). Increase if needed.
const maxMergePasses = 8;

// ---- Site label fade (near only) ----
// Make sure labels are fully visible at ~1200m.
const siteLabelNear = 0;
const siteLabelFar = 80_000;
const siteLabelFarAlpha = 0.0;

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

// Sites datasource (individual points)
const sitesDS = new Cesium.CustomDataSource("sites");
viewer.dataSources.add(sitesDS);

// Cluster bubbles datasource (rendered clusters)
const clustersDS = new Cesium.CustomDataSource("clusters");
viewer.dataSources.add(clustersDS);

// Cluster state
let clustersAreOn = false;
let lastClusterBuildAt = 0;
let lastCamHeightBucket = -1;

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

function setSitesVisible(isVisible) {
  for (const e of sitesDS.entities.values) {
    if (e.point) e.point.show = isVisible;
    if (e.billboard) e.billboard.show = isVisible;
    if (e.label) e.label.show = isVisible;
  }
}

function clearClusters() {
  clustersDS.entities.removeAll();
}

function getCameraHeight() {
  return viewer.camera.positionCartographic.height;
}

function shouldClusterNow() {
  const h = getCameraHeight();
  return h > clusterStartMeters;
}

function getHeightBucket(height) {
  // coarse bucket so we don't rebuild every micro-zoom
  // tweak divisor if you want more/less sensitivity
  return Math.floor(height / 2500);
}

function getWorldPosition(entity) {
  return entity.position.getValue(Cesium.JulianDate.now());
}

function projectToScreen(cartesian) {
  return Cesium.SceneTransforms.wgs84ToWindowCoordinates(viewer.scene, cartesian);
}

function avgPositionCartesians(cartesians) {
  // average in ECEF; fine for cluster centroids at this scale
  let sx = 0, sy = 0, sz = 0;
  for (const c of cartesians) {
    sx += c.x; sy += c.y; sz += c.z;
  }
  const n = Math.max(1, cartesians.length);
  return new Cesium.Cartesian3(sx / n, sy / n, sz / n);
}

function makeClusterBubbleEntity({ position, sumPop, count, pixelSize }) {
  const popLine = `Pop: ${fmtInt(sumPop)}`;
  const countLine = showClusterSiteCount ? `\nSites: ${count}` : "";

  return clustersDS.entities.add({
    position,
    point: {
      show: true,
      pixelSize,
      color: Cesium.Color.YELLOW.withAlpha(clusterBubbleAlpha),
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: clusterBubbleOutlineWidth,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      show: true,
      text: `${popLine}${countLine}`,
      font: clusterFontForBubble(pixelSize),
      fillColor: Cesium.Color.BLACK,
      outlineWidth: 0,
      showBackground: false,
      verticalOrigin: Cesium.VerticalOrigin.CENTER,
      horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
      pixelOffset: Cesium.Cartesian2.ZERO,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      translucencyByDistance: new Cesium.NearFarScalar(
        clusterTextNear, 1.0, clusterTextFar, clusterTextFarAlpha
      ),
      scaleByDistance: new Cesium.NearFarScalar(
        clusterTextNear, 1.0, clusterTextFar, 1.0
      ),
    },
  });
}

// =============================================================
// CUSTOM CLUSTER BUILD (NO OVERLAP)
// =============================================================
function buildNoOverlapClusters() {
  const now = performance.now();
  if (now - lastClusterBuildAt < clusterRebuildThrottleMs) return;
  lastClusterBuildAt = now;

  const height = getCameraHeight();
  const heightBucket = getHeightBucket(height);

  // Rebuild if zoom bucket changed or if we toggled modes
  const wantClusters = shouldClusterNow();

  if (!wantClusters) {
    if (clustersAreOn) {
      clustersAreOn = false;
      clearClusters();
      setSitesVisible(true); // show individual sites
    }
    lastCamHeightBucket = heightBucket;
    return;
  }

  // Want clustering
  if (!clustersAreOn) {
    clustersAreOn = true;
    setSitesVisible(false); // hide individual sites when clusters are on
  }

  // If height bucket didn't change, still rebuild sometimes while panning
  // because screen overlap depends on camera center too. We'll still rebuild due to throttle.

  // Collect visible site entities with screen positions
  const items = [];
  for (const e of sitesDS.entities.values) {
    const pos = getWorldPosition(e);
    if (!pos) continue;

    const sp = projectToScreen(pos);
    if (!sp) continue;

    // Skip if offscreen too far (optional)
    if (
      sp.x < -200 || sp.y < -200 ||
      sp.x > canvas.clientWidth + 200 ||
      sp.y > canvas.clientHeight + 200
    ) continue;

    const pop = e.properties?.population?.getValue?.(Cesium.JulianDate.now());
    const p = Number.isFinite(pop) ? pop : 0;

    items.push({
      entity: e,
      pos,
      sp,
      pop: p,
    });
  }

  // If nothing to cluster
  if (items.length === 0) {
    clearClusters();
    lastCamHeightBucket = heightBucket;
    return;
  }

  // Start with each site as its own "cluster"
  let clusters = items.map((it) => ({
    members: [it],
    // These will be computed:
    sumPop: it.pop,
    count: 1,
    worldPositions: [it.pos],
    screenX: it.sp.x,
    screenY: it.sp.y,
    pixelSize: pickBucketSize(
      clusterSizeByPopulation
        ? (16 + Math.log10(Math.max(it.pop, 1)) * 18)
        : (18 + Math.sqrt(1) * 12)
    ),
  }));

  // Helper to recompute cluster properties from members
  function recompute(c) {
    c.sumPop = 0;
    c.count = c.members.length;
    c.worldPositions = [];
    let sx = 0, sy = 0;

    for (const m of c.members) {
      c.sumPop += m.pop;
      c.worldPositions.push(m.pos);
      sx += m.sp.x;
      sy += m.sp.y;
    }

    const n = Math.max(1, c.members.length);
    c.screenX = sx / n;
    c.screenY = sy / n;

    let rawSize;
    if (clusterSizeByPopulation) {
      rawSize = 16 + Math.log10(Math.max(c.sumPop, 1)) * 18;
    } else {
      rawSize = 18 + Math.sqrt(c.count) * 12;
    }
    c.pixelSize = pickBucketSize(rawSize);
  }

  // Merge pass: if any two bubbles overlap/touch => merge them
  function bubblesOverlap(a, b) {
    const rA = a.pixelSize * 0.5;
    const rB = b.pixelSize * 0.5;
    const dx = a.screenX - b.screenX;
    const dy = a.screenY - b.screenY;
    const dist2 = dx * dx + dy * dy;
    const minDist = rA + rB + bubblePaddingPx;
    return dist2 <= minDist * minDist;
  }

  // Iteratively merge until stable or max passes
  for (let pass = 0; pass < maxMergePasses; pass++) {
    let mergedAny = false;

    // simple O(n^2) merge (fine for a few hundred points; if you hit 2k+ we can grid-accelerate)
    outer: for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const a = clusters[i];
        const b = clusters[j];

        if (!bubblesOverlap(a, b)) continue;

        // Merge b into a
        a.members.push(...b.members);
        recompute(a);

        // Remove b
        clusters.splice(j, 1);
        mergedAny = true;

        // Restart inner loop since indices changed
        break outer;
      }
    }

    if (!mergedAny) break;

    // After a merge, we should recompute everything might have changed:
    for (const c of clusters) recompute(c);
  }

  // Render clusters
  clearClusters();

  for (const c of clusters) {
    // If a cluster has just 1 member, it's still a bubble at this zoom level.
    // That’s fine — it guarantees no overlaps. (If you prefer singletons to show as dots, tell me.)
    const centerWorld = avgPositionCartesians(c.worldPositions);

    makeClusterBubbleEntity({
      position: centerWorld,
      sumPop: c.sumPop,
      count: c.count,
      pixelSize: c.pixelSize,
    });
  }

  lastCamHeightBucket = heightBucket;
}

// =============================================================
// TOUR TICK
// =============================================================
viewer.clock.onTick.addEventListener(() => {
  // HARD OFF under threshold (small dots)
  // We do this by not clustering and ensuring site entities are visible.
  const height = getCameraHeight();
  if (height <= noClusterAtOrBelowMeters) {
    if (clustersAreOn) {
      clustersAreOn = false;
      clearClusters();
    }
    setSitesVisible(true);
  } else {
    // Build non-overlapping clusters when zoomed out enough
    buildNoOverlapClusters();
  }

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

    await zoomDownFlat(); // ends at ~1200m
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

  // A–F Installed Systems table
  const IDX_INST_CUST_ID = 0; // A
  const IDX_INST_STATUS = 4;  // E

  // I–L Population table
  const IDX_POP_CUST_ID = 8;   // I
  const IDX_POP_YEAR = 9;      // J
  const IDX_POP_VALUE = 10;    // K

  // O–Q Locations table
  const IDX_LOC_ID = 14;       // O
  const IDX_LOC_COORDS = 16;   // Q

  // S–V Customers table
  const IDX_CUST_ID = 18;      // S
  const IDX_CUST_NAME = 19;    // T
  const IDX_CUST_LOC_ID = 21;  // V

  // Reset
  sitesDS.entities.removeAll();
  clustersDS.entities.removeAll();
  entities.length = 0;
  siteItems.length = 0;

  // PASS 0: Installed IDs
  const installedIds = new Set();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];

    const custIdNum = toNum(row[IDX_INST_CUST_ID]);
    if (custIdNum == null) continue;

    const status = String(row[IDX_INST_STATUS] ?? "").trim().toLowerCase();
    if (status !== "installed") continue;

    installedIds.add(String(Math.trunc(custIdNum)));
  }

  // PASS 1: Latest population per customer id
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

  // PASS 2: Coords by loc id
  const coordsByLocId = new Map();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];

    const locIdNum = toNum(row[IDX_LOC_ID]);
    if (locIdNum == null) continue;

    const coord = parseCoordinatesLatLon(row[IDX_LOC_COORDS]);
    if (!coord) continue;

    coordsByLocId.set(String(Math.trunc(locIdNum)), coord);
  }

  // PASS 3: Customer name + locId by customer id
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
    if (!customerById.has(id)) customerById.set(id, { name, locId });
  }

  // PASS 4: Add entities (installed + coords + pop)
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
        customerName: customerName,
        population: pop,
        year: popRec.year,
        locId: cust.locId,
      },

      // Dot
      point: {
        pixelSize: popToPixelSize(pop),
        color: Cesium.Color.YELLOW,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        show: true,
      },

      // Pin (optional)
      billboard: {
        image: "./icons/solar_pin.png",
        width: 28,
        height: 28,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(1_000.0, 1.0, 5_000_000.0, 0.4),
        show: true,
      },

      // Individual site label (near only)
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
        show: true,
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

  // Start with correct visibility given current height
  const h = getCameraHeight();
  if (h <= noClusterAtOrBelowMeters) {
    clustersAreOn = false;
    clearClusters();
    setSitesVisible(true);
  } else {
    // Force a first build
    lastClusterBuildAt = 0;
    buildNoOverlapClusters();
  }
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
``
