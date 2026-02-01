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
// Mobile sidebar toggle (hamburger)
// -------------------------------
const sidebar = document.getElementById("sidebar");
const menuToggle = document.getElementById("menuToggle");

function isMobileLayout() {
  return window.matchMedia("(max-width: 768px)").matches;
}

function setMenuButtonState(isOpen) {
  if (!menuToggle) return;
  menuToggle.textContent = isOpen ? "✕" : "☰";
  menuToggle.setAttribute("aria-label", isOpen ? "Close menu" : "Open menu");
}

function closeSidebar() {
  if (!sidebar) return;
  sidebar.classList.remove("open");
  setMenuButtonState(false);
}

if (menuToggle && sidebar) {
  // Mobile: toggle sidebar
  menuToggle.addEventListener("click", (e) => {
    if (!isMobileLayout()) return;
    e.stopPropagation();
    sidebar.classList.toggle("open");
    setMenuButtonState(sidebar.classList.contains("open"));
  });

  // Tap/drag on the globe closes the sidebar on mobile
  const cesiumEl = document.getElementById("cesiumContainer");
  if (cesiumEl) {
    cesiumEl.addEventListener("pointerdown", () => {
      if (isMobileLayout()) closeSidebar();
    });
  }

  // If you rotate/resize between desktop and mobile, keep behavior sane
  window.addEventListener("resize", () => {
    if (isMobileLayout()) {
      closeSidebar(); // default closed on mobile
    } else {
      // Desktop: sidebar stays visible and button does nothing
      sidebar.classList.remove("open");
      setMenuButtonState(false);
    }
  });

  // Initial state
  setMenuButtonState(false);
}

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
const overviewRangeMeters = 2550000; // how far OUT between sites
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

// =============================================================
// DATA + ENTITIES
// =============================================================
let entities = []; // {name, lat, lon, desc, entity}
let activeIndex = 0;

let autoAdvance = true;
let orbit = false;
let headingDeg = 0;

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const header = lines[0].split(",").map((h) => h.trim());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];

    // simple CSV with commas; supports quoted text
    const parts = [];
    let cur = "";
    let inQuotes = false;
    for (let c = 0; c < raw.length; c++) {
      const ch = raw[c];
      if (ch === '"') {
        inQuotes = !inQuotes;
        continue;
      }
      if (ch === "," && !inQuotes) {
        parts.push(cur);
        cur = "";
        continue;
      }
      cur += ch;
    }
    parts.push(cur);

    const obj = {};
    for (let j = 0; j < header.length; j++) obj[header[j]] = (parts[j] || "").trim();
    rows.push(obj);
  }
  return rows;
}

async function buildEntitiesFromCSV() {
  let text = "";
  try {
    const res = await fetch("./sites.csv", { cache: "no-cache" });
    if (!res.ok) throw new Error(`Failed to fetch sites.csv: ${res.status}`);
    text = await res.text();
  } catch (err) {
    console.warn("Could not load sites.csv. Using empty list.", err);
    return;
  }

  const rows = parseCSV(text);

  entities = rows
    .map((r) => {
      const name = r.name || r.Name || r.title || r.Title || "";
      const lat = parseFloat(r.lat || r.latitude || r.Lat || r.Latitude);
      const lon = parseFloat(r.lon || r.lng || r.longitude || r.Lon || r.Longitude || r.Lng);

      const desc = r.desc || r.description || r.Desc || r.Description || "";
      const region = r.region || r.Region || "";
      const country = r.country || r.Country || "";
      const sub = [region, country].filter(Boolean).join(" • ");

      if (!name || Number.isNaN(lat) || Number.isNaN(lon)) return null;

      const entity = viewer.entities.add({
        name,
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        point: {
          pixelSize: 10,
          outlineWidth: 2,
          outlineColor: Cesium.Color.BLACK,
          color: Cesium.Color.ORANGE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: name,
          font: "14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          outlineWidth: 3,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -14),
          showBackground: true,
          backgroundColor: new Cesium.Color(0, 0, 0, 0.55),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        description: desc || sub || "",
      });

      return { name, lat, lon, desc, sub, entity };
    })
    .filter(Boolean);

  // Double click on marker zooms in
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction(async (movement) => {
    const picked = viewer.scene.pick(movement.position);
    if (!picked || !picked.id) return;

    const idx = entities.findIndex((x) => x.entity === picked.id);
    if (idx === -1) return;

    autoAdvance = false;
    orbit = false;
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);

    activeIndex = idx;
    await goAboveSiteFlat();
    await zoomDownFlat();

    // Close sidebar after selecting a site on mobile
    if (isMobileLayout()) closeSidebar();
  }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

  // Stop tour/orbit when user takes control
  const stopAuto = () => {
    autoAdvance = false;
    orbit = false;
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  };
  viewer.camera.moveStart.addEventListener(stopAuto);
  viewer.scene.screenSpaceCameraController.enableLook = true;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function currentSite() {
  return entities[clamp(activeIndex, 0, entities.length - 1)];
}

function cartFromSite(site) {
  return Cesium.Cartesian3.fromDegrees(site.lon, site.lat);
}

async function flyToDestination(destination, duration, headingDegArg, pitchDegArg, rangeMetersArg) {
  return viewer.camera.flyTo({
    destination,
    duration,
    orientation: {
      heading: Cesium.Math.toRadians(headingDegArg),
      pitch: Cesium.Math.toRadians(pitchDegArg),
      roll: 0,
    },
  });
}

async function goAboveSiteFlat() {
  const site = currentSite();
  const pos = Cesium.Cartesian3.fromDegrees(site.lon, site.lat, overviewRangeMeters);
  await viewer.camera.flyTo({
    destination: pos,
    duration: travelSeconds,
    orientation: {
      heading: Cesium.Math.toRadians(flatHeadingDeg),
      pitch: Cesium.Math.toRadians(-90),
      roll: 0,
    },
  });
}

async function zoomDownFlat() {
  const site = currentSite();
  const pos = Cesium.Cartesian3.fromDegrees(site.lon, site.lat, siteRangeMeters);
  await viewer.camera.flyTo({
    destination: pos,
    duration: zoomInSeconds,
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-90),
      roll: 0,
    },
  });
}

async function tiltIntoOrbitPitch() {
  const site = currentSite();
  const pos = Cesium.Cartesian3.fromDegrees(site.lon, site.lat, siteRangeMeters);
  await viewer.camera.flyTo({
    destination: pos,
    duration: tiltSeconds,
    orientation: {
      heading: Cesium.Math.toRadians(headingDeg),
      pitch: Cesium.Math.toRadians(orbitPitchDeg),
      roll: 0,
    },
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runTour() {
  while (autoAdvance) {
    // travel above site
    await goAboveSiteFlat();
    if (!autoAdvance) break;

    // zoom down
    await zoomDownFlat();
    if (!autoAdvance) break;

    // tilt into orbit pitch, then orbit for holdSeconds
    headingDeg = 0;
    orbit = true;
    await tiltIntoOrbitPitch();
    if (!autoAdvance) break;

    const start = performance.now();
    while (orbit && autoAdvance && performance.now() - start < holdSeconds * 1000) {
      headingDeg += orbitSpeedDegPerSec * (1 / 60);
      viewer.camera.setView({
        orientation: {
          heading: Cesium.Math.toRadians(headingDeg),
          pitch: Cesium.Math.toRadians(orbitPitchDeg),
          roll: 0,
        },
      });
      await sleep(1000 / 60);
    }

    orbit = false;
    if (!autoAdvance) break;

    // advance
    activeIndex = (activeIndex + 1) % entities.length;
  }
}

// =============================================================
// SIDEBAR LIST + SEARCH
// =============================================================
let filtered = [];

function renderSiteList() {
  const list = document.getElementById("siteList");
  if (!list) return;

  list.innerHTML = "";
  filtered.forEach((s, idx) => {
    const row = document.createElement("div");
    row.className = "siteRow";
    row.innerHTML = `
      <div>${s.name}</div>
      ${s.sub ? `<div class="siteSub">${s.sub}</div>` : ""}
    `;
    row.addEventListener("click", async () => {
      autoAdvance = false;
      orbit = false;
      viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);

      activeIndex = entities.indexOf(s);
      await goAboveSiteFlat();
      await zoomDownFlat();

      // Close sidebar after selecting a site on mobile
      if (isMobileLayout()) closeSidebar();
    });
    list.appendChild(row);
  });
}

function wireSearchBox() {
  const input = document.getElementById("siteSearch");
  if (!input) return;

  filtered = entities.slice();

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    if (!q) {
      filtered = entities.slice();
    } else {
      filtered = entities.filter((s) => {
        const hay = `${s.name} ${s.sub || ""}`.toLowerCase();
        return hay.includes(q);
      });
    }
    renderSiteList();
  });
}

// =============================================================
// KEYBOARD SHORTCUTS (H/T/R/N/P)
// =============================================================
document.addEventListener(
  "keydown",
  async (e) => {
    const k = (e.key || "").toLowerCase();

    const active = document.activeElement;
    const isSearch = active && active.id === "siteSearch";

    const isShortcut = ["h", "t", "r", "n", "p"].includes(k);

    // If typing in search, ignore shortcuts unless it's a shortcut
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
// START
// =============================================================
(async function init() {
  await buildEntitiesFromCSV();

  wireSearchBox();
  filtered = entities.slice();
  renderSiteList();

  if (entities.length === 0) {
    console.warn("No sites loaded from sites.csv; tour not started.");
    return;
  }

  runTour();
})();
