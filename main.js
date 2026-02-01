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

// -------------------------------
// Sites as [lon, lat]
// -------------------------------
const sites = [
  [31.428655467144992, 0.9614846273101064],
  [34.01854528405185, 0.7197713258559371],
  [30.610227104827818, 0.6947441058489014],
  [32.91984166612055, 0.686121295563971],
  [33.326719075381885, 0.6598445605145666],
];

// -------------------------------
// Dots
// -------------------------------
const entities = [];
sites.forEach((p, i) => {
  entities.push(
    viewer.entities.add({
      name: `Site ${i + 1}`,
      position: Cesium.Cartesian3.fromDegrees(p[0], p[1]),
      point: {
        pixelSize: 10,
        color: Cesium.Color.YELLOW,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })
  );
});

// =============================================================
// KNOBS YOU CARE ABOUT
// =============================================================

// Camera distances
const overviewRangeMeters = 13500000; // how far OUT between sites (Uganda view)
const siteRangeMeters = 1200;       // how close IN at the site

// Travel behavior
const travelSeconds = 1.5;          // "move above next site" + "zoom out"
const zoomInSeconds = 1.5;          // zooming down flat
const tiltSeconds = 0.000001;            // how fast it tilts into orbit pitch

// Orbit behavior (ONLY while holding at the site)
const orbitPitchDeg = -45;          // the tilt angle once at the site
const orbitSpeedDegPerSec = 8;      // rotation speed at the site
const holdSeconds = 3;              // how long to rotate at each site

// Flat travel orientation (north-up, no rotation)
const flatHeadingDeg = 0;           // north-up
const flatPitchDeg = -90;           // straight down

// Auto tour
let autoAdvance = true;

// =============================================================
// INTERNAL STATE
// =============================================================
let activeIndex = 0;
let orbit = false;                 // IMPORTANT: orbit starts OFF (travel flat)
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
    durationSec: travelSeconds,
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

  // While orbiting, keep same range + pitch, only change heading
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
    // 1) Move above current site flat (this also helps “re-acquire” if user moved)
    await goAboveSiteFlat();
    if (!autoAdvance) break;

    // 2) Zoom down flat
    await zoomDownFlat();
    if (!autoAdvance) break;

    // 3) Tilt into orbit pitch (still no rotation)
    await tiltIntoOrbitPitch();
    if (!autoAdvance) break;

    // 4) Start rotating at site
    headingDeg = 0;
    orbit = true;
    await sleep(holdSeconds * 1000);

    // 5) Stop rotating, tilt back flat
    orbit = false;
    await tiltBackToFlat();
    if (!autoAdvance) break;

    // 6) Zoom out flat (Uganda view)
    await goAboveSiteFlat();
    if (!autoAdvance) break;

    // 7) Next site
    activeIndex = (activeIndex + 1) % entities.length;
  }
}

// =============================================================
// START
// =============================================================
runTour();

// =============================================================
// CONTROLS
// =============================================================
const canvas = viewer.scene.canvas;
canvas.setAttribute("tabindex", "0");
canvas.focus();

// Click stops the tour and orbit, gives user control
canvas.addEventListener("mousedown", () => {
  autoAdvance = false;
  orbit = false;
  viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
});

canvas.addEventListener("keydown", async (e) => {
  const k = e.key.toLowerCase();

  // R = resume orbit at current site (tilt first, then orbit)
  if (k === "r") {
    autoAdvance = false; // manual mode
    orbit = false;
    await zoomDownFlat();
    await tiltIntoOrbitPitch();
    headingDeg = 0;
    orbit = true;
    e.preventDefault();
  }

  // N = next site (flat travel sequence, no orbit until you press R or restart tour)
  if (k === "n") {
    autoAdvance = false;
    orbit = false;
    activeIndex = (activeIndex + 1) % entities.length;
    await goAboveSiteFlat();
    await zoomDownFlat();
    e.preventDefault();
  }

  // P = previous site
  if (k === "p") {
    autoAdvance = false;
    orbit = false;
    activeIndex = (activeIndex - 1 + entities.length) % entities.length;
    await goAboveSiteFlat();
    await zoomDownFlat();
    e.preventDefault();
  }

  // T = toggle auto tour
  if (k === "t") {
    autoAdvance = !autoAdvance;
    if (autoAdvance) runTour();
    e.preventDefault();
  }
});
