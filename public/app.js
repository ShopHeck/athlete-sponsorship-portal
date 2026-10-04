import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { buildArena, ROPE_RADIUS } from "./arena.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { DecalGeometry } from "three/addons/geometries/DecalGeometry.js";

/* ---------------------------------------------------------------------------
   Placements are defined in the tenant config as rectangles in metres on a
   viewing side; each is raycast onto the model and projected as a decal.
--------------------------------------------------------------------------- */
const MODEL_HEIGHT = 1.86;
const THREE_ADDONS = "/vendor/three-0.170.0/addons/";
const config = JSON.parse(document.getElementById("portal-config").textContent);
const isStudio = Boolean(config.studio);
const isShowcase = Boolean(config.showcase) && !isStudio;
const isDemo = Boolean(config.demo) && !isStudio;
const garments = config.garments;
const allPlacements = garments.flatMap((garment) => garment.placements);
const isConfiguredSold = (id) => Object.hasOwn(config.sold || {}, id);
const showcasePlacements = isShowcase ? allPlacements.filter((spot) => isConfiguredSold(spot.id)) : [];
const garmentPlacements = (garment) => isShowcase
  ? garment.placements.filter((spot) => isConfiguredSold(spot.id))
  : garment.placements;
const garmentConfig = (id) => garments.find((garment) => garment.id === id);
const garmentOf = (id) => garments.find((garment) => garment.placements.some((spot) => spot.id === id))?.id || garments[0].id;
const firstPlacement = isShowcase ? showcasePlacements[0] || null : allPlacements[0];
const accentColor = new THREE.Color(config.brand.accent);
const formatCopy = (template, values = {}) => String(template).replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_, key) => values[key] ?? "");

const SIDE_AZIMUTH = { front: 0, back: Math.PI, left: Math.PI / 2, right: -Math.PI / 2 };
const state = { garment: firstPlacement ? garmentOf(firstPlacement.id) : garments[0].id, selected: firstPlacement?.id || null, hovered: null, logos: {}, logoImages: {}, sold: {}, soldImages: {}, bidImages: {}, azimuth: 0, bids: {}, auction: { minBid: config.pricing.minBid, increment: config.pricing.increment, lockPrice: config.pricing.lockPrice, deadline: config.pricing.deadline, online: false, paymentsReady: true } };
const BIDS_URL = `/api/${config.slug}/bids`;
const previewHeaders = config.previewToken ? { "x-preview-token": config.previewToken } : {};
const isLocked = (id) => Boolean(state.bids[id]?.locked || state.bids[id]?.closed);
const isSold = (id) => Boolean(state.sold[id]) || isLocked(id);
const usd = (n) => new Intl.NumberFormat("en-US", { style: "currency", currency: config.pricing.currency.toUpperCase(), maximumFractionDigits: 0 }).format(Math.round(n));
const minimumBid = (id) => { const b = state.bids[id]; return Math.max(state.auction.minBid, b?.high ? b.high + state.auction.increment : 0); };

/* ------------------------------------------------------------------ DOM */
const stage = document.getElementById("modelStage");
const canvas = document.getElementById("viewer");
const loadingEl = document.getElementById("loadingText");
const loadBar = document.getElementById("loadBar");
const specRow = document.getElementById("specRow");
const inventoryList = document.getElementById("inventoryList");
const inventoryTitle = document.getElementById("inventoryTitle");
const selectionCode = document.getElementById("selectionCode");
const selectionName = document.getElementById("selectionName");
const selectionDescription = document.getElementById("selectionDescription");
const selectionStatus = document.getElementById("selectionStatus");
const selectionCard = document.getElementById("selectionCard");
const availabilityEl = document.getElementById("availability");
const uploadLabel = document.getElementById("uploadLabel");
const previewThumb = document.getElementById("previewThumb");
const previewImg = document.getElementById("previewImg");
const removePreview = document.getElementById("removePreview");
const sponsorLogoEl = document.getElementById("sponsorLogo");
const openPlacementsBtn = document.getElementById("openPlacements");
const bidForm = document.getElementById("bidForm");
const bidHigh = document.getElementById("bidHigh");
const bidMeta = document.getElementById("bidMeta");
const bidError = document.getElementById("bidError");
const bidButton = document.getElementById("bidButton");
const lockButton = document.getElementById("lockButton");
const bidNote = document.getElementById("bidNote");
const bidNoteText = document.getElementById("bidNote").firstChild;
if (isStudio) {
  bidNoteText.data = "Preview only — bidding is disabled. ";
  bidForm.querySelectorAll("input,button").forEach((control) => { control.disabled = true; });
  lockButton.disabled = true;
} else if (isDemo) {
  bidForm.querySelectorAll("input,button").forEach((control) => { control.disabled = true; });
  lockButton.disabled = true;
}
const lockPriceEl = document.getElementById("lockPrice");
const lockLabel = document.getElementById("lockLabel");
const bidSuccess = document.getElementById("bidSuccess");
const bidSuccessTitle = document.getElementById("bidSuccessTitle");
const bidSuccessText = document.getElementById("bidSuccessText");
const bidSuccessLink = document.getElementById("bidSuccessLink");
const toastEl = document.getElementById("toast");
let toastTimer = null;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("is-visible"), 3200);
}
const orientationLabel = document.getElementById("orientationLabel");
const orientationNeedle = document.getElementById("orientationNeedle");

/* ------------------------------------------------------------ renderer */
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
const MAX_PIXEL_RATIO = Math.min(window.devicePixelRatio || 1, 2);
let pixelRatio = MAX_PIXEL_RATIO;
renderer.setPixelRatio(pixelRatio);
// Neutral tone mapping keeps sponsor brand colours true to their artwork.
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
// Lights and athlete are static: the shadow map is redrawn only when the scene changes.
renderer.shadowMap.autoUpdate = false;
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Frames are drawn only when something changed (camera, decals, resize).
let needsRender = true;
const invalidate = () => { needsRender = true; };

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;

const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 40);
const HOME = { dist: 3.05, polar: 1.57, targetY: 0.95 };
const TARGET = new THREE.Vector3(0, HOME.targetY, 0);
camera.position.setFromSpherical(new THREE.Spherical(HOME.dist, HOME.polar, 0)).add(TARGET);

const controls = new OrbitControls(camera, canvas);
controls.target.copy(TARGET);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.minDistance = 1.2;
controls.maxDistance = ROPE_RADIUS - 0.2; // stay inside the ropes
controls.minPolarAngle = 0.9;
controls.maxPolarAngle = 1.75;
controls.autoRotate = false;
controls.autoRotateSpeed = 0.7;
let userInteracted = false;
controls.addEventListener("start", () => { controls.autoRotate = false; userInteracted = true; tween = null; });
controls.addEventListener("change", invalidate);

const arena = buildArena(scene, config.ring);

const key = new THREE.DirectionalLight(0xfff0dc, 2.5);
key.position.set(2.5, 4.5, 3.5);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 1; key.shadow.camera.far = 12;
key.shadow.camera.left = key.shadow.camera.bottom = -1.6;
key.shadow.camera.right = key.shadow.camera.top = 1.6;
key.shadow.bias = -0.0005; key.shadow.normalBias = 0.03;
key.shadow.radius = 4;
scene.add(key);
const rim = new THREE.DirectionalLight(accentColor, 1.9);
rim.position.set(-3, 2.2, -3.5);
scene.add(rim);
// Cool edge light from the opposite back corner separates the silhouette from the backdrop.
const edge = new THREE.DirectionalLight(0xdfe8ff, 1.1);
edge.position.set(3.2, 2.8, -3);
scene.add(edge);
const fill = new THREE.DirectionalLight(0x8fa3ff, 0.45);
fill.position.set(-2.5, 1.5, 3);
scene.add(fill);
scene.add(new THREE.AmbientLight(0xffffff, 0.15));

// Shadow-only floor so the fight-poster backdrop shows through and the athlete still grounds with a soft shadow.
const floor = new THREE.Mesh(new THREE.CircleGeometry(ROPE_RADIUS + 0.4, 96), new THREE.ShadowMaterial({ opacity: 0.55 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
const ring = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.66, 96), new THREE.MeshBasicMaterial({ color: accentColor, transparent: true, opacity: 0.85, side: THREE.DoubleSide }));
ring.rotation.x = -Math.PI / 2; ring.position.y = 0.002;
scene.add(ring);
// Soft spotlight pool on the canvas under the athlete.
const pool = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.4), new THREE.MeshBasicMaterial({
  map: (() => {
    const c = document.createElement("canvas"); c.width = c.height = 256;
    const g = c.getContext("2d");
    const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, "rgba(255,244,228,0.55)");
    grad.addColorStop(0.35, "rgba(255,244,228,0.22)");
    grad.addColorStop(1, "rgba(255,244,228,0)");
    g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })(),
  transparent: true, depthWrite: false, toneMapped: false
}));
pool.rotation.x = -Math.PI / 2; pool.position.y = 0.001; pool.renderOrder = -1;
scene.add(pool);

const athlete = new THREE.Group();
scene.add(athlete);

/* ------------------------------------------------------------- slots */
const slotMeshes = [];
const decalMaterialBase = { transparent: true, roughness: 0.7, metalness: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 };

function slotTexture(spec) {
  const c = document.createElement("canvas");
  c.width = 512; c.height = Math.max(160, Math.round(512 * spec.h / spec.w));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return { canvas: c, tex };
}
// Artwork is drawn at 1024px wide so sponsor logos stay crisp in close-ups; empty slots stay at 512px.
function ensureArtworkResolution(slot) {
  if (slot.canvas.width >= 1024) return;
  const { spot } = slot;
  slot.canvas.width = 1024;
  slot.canvas.height = Math.max(320, Math.round(1024 * spot.h / spot.w));
  slot.tex.dispose();
  slot.tex = new THREE.CanvasTexture(slot.canvas);
  slot.tex.colorSpace = THREE.SRGBColorSpace;
  slot.tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  slot.mesh.material.map = slot.tex;
}
function drawSlot(slot) {
  const { spot } = slot;
  const selected = spot.id === state.selected;
  const hovered = spot.id === state.hovered && !selected;
  const soldImg = state.soldImages[spot.id] || (isLocked(spot.id) ? state.bidImages[spot.id] : null);
  const bidState = state.bids[spot.id];
  const inputs = [selected, hovered, soldImg, state.logoImages[spot.id], bidState?.locked, bidState?.closed, bidState?.high];
  // Skip the canvas redraw and texture upload when nothing this slot shows has changed.
  if (slot.inputs && inputs.every((v, i) => v === slot.inputs[i])) return;
  slot.inputs = inputs;
  if (soldImg || state.logoImages[spot.id]) ensureArtworkResolution(slot);
  const { canvas: c, tex } = slot;
  const g = c.getContext("2d");
  const u = c.width / 512;
  g.clearRect(0, 0, c.width, c.height);
  invalidate();
  if (soldImg) {
    const pad = 6 * u, bw = c.width - pad * 2, bh = c.height - pad * 2;
    const k = Math.min(bw / soldImg.width, bh / soldImg.height);
    g.drawImage(soldImg, (c.width - soldImg.width * k) / 2, (c.height - soldImg.height * k) / 2, soldImg.width * k, soldImg.height * k);
    if (selected || hovered) { g.lineWidth = 8 * u; g.strokeStyle = selected ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.4)"; roundRect(g, 5 * u, 5 * u, c.width - 10 * u, c.height - 10 * u, 16 * u); g.stroke(); }
    tex.needsUpdate = true;
    return;
  }
  const img = state.logoImages[spot.id];
  if (img) {
    g.fillStyle = "rgba(255,255,255,0.96)";
    roundRect(g, 6 * u, 6 * u, c.width - 12 * u, c.height - 12 * u, 14 * u); g.fill();
    const pad = 22 * u, bw = c.width - pad * 2, bh = c.height - pad * 2;
    const k = Math.min(bw / img.width, bh / img.height);
    g.drawImage(img, (c.width - img.width * k) / 2, (c.height - img.height * k) / 2, img.width * k, img.height * k);
  } else {
    g.fillStyle = selected ? "rgba(255,255,255,0.92)" : hovered ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.14)";
    roundRect(g, 8, 8, c.width - 16, c.height - 16, 14); g.fill();
    g.setLineDash([16, 10]); g.lineWidth = 6;
    g.strokeStyle = selected ? config.brand.accent : "rgba(255,255,255,0.9)";
    roundRect(g, 8, 8, c.width - 16, c.height - 16, 14); g.stroke();
    g.setLineDash([]);
    g.fillStyle = selected ? config.brand.accent : "#fff"; g.textAlign = "center"; g.textBaseline = "middle";
    const bid = state.bids[spot.id];
    if (bid?.locked || bid?.closed) {
      g.font = `700 ${Math.round(c.height * 0.26)}px "Barlow Condensed", Impact, sans-serif`;
      g.fillText(bid.locked ? config.copy.lockedStatus : config.copy.wonStatus, c.width / 2, c.height / 2 + 2);
    } else if (bid?.high) {
      g.font = `700 ${Math.round(c.height * 0.28)}px "Barlow Condensed", Impact, sans-serif`;
      g.fillText(spot.id.replace(/^[A-Z]+-/, ""), c.width / 2, c.height * 0.36);
      g.font = `600 ${Math.round(c.height * 0.22)}px "Barlow Condensed", Impact, sans-serif`;
      g.fillText(usd(bid.high), c.width / 2, c.height * 0.68);
    } else {
      g.font = `700 ${Math.round(c.height * 0.36)}px "Barlow Condensed", Impact, sans-serif`;
      g.fillText(spot.id.replace(/^[A-Z]+-/, ""), c.width / 2, c.height / 2 + 2);
    }
  }
  if (selected) { g.lineWidth = 10 * u; g.strokeStyle = config.brand.accent; roundRect(g, 5 * u, 5 * u, c.width - 10 * u, c.height - 10 * u, 16 * u); g.stroke(); }
  tex.needsUpdate = true;
}
function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }

// Ray origin/direction that looks at the model from a given side.
const SIDE_RAY = {
  front: (x, y) => [new THREE.Vector3(x, y, 3), new THREE.Vector3(0, 0, -1)],
  back: (x, y) => [new THREE.Vector3(x, y, -3), new THREE.Vector3(0, 0, 1)],
  left: (x, y) => [new THREE.Vector3(3, y, x), new THREE.Vector3(-1, 0, 0)],
  right: (x, y) => [new THREE.Vector3(-3, y, -x), new THREE.Vector3(1, 0, 0)]
};
const projector = new THREE.Raycaster();

function makeSlot(spot, side, meshes) {
  const spec = { ...spot, side };
  const [origin, dir] = SIDE_RAY[side](spec.x, spec.y);
  projector.set(origin, dir);
  const hit = projector.intersectObjects(meshes, false)[0];
  if (!hit) { console.warn("No surface found for placement", spot.id, side); return null; }
  const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
  if (normal.dot(dir) > 0) normal.negate();
  const m = new THREE.Matrix4().lookAt(hit.point.clone().add(normal), hit.point, new THREE.Vector3(0, 1, 0));
  const orientation = new THREE.Euler().setFromRotationMatrix(m);
  const geo = new DecalGeometry(hit.object, hit.point, orientation, new THREE.Vector3(spec.w, spec.h, 0.10));
  const { canvas: c, tex } = slotTexture(spec);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, ...decalMaterialBase }));
  mesh.userData.spotId = spot.id;
  mesh.renderOrder = 2;
  athlete.add(mesh);
  const slot = { spot, side, mesh, canvas: c, tex, point: hit.point.clone(), normal };
  slotMeshes.push(slot);
  drawSlot(slot);
  return slot;
}

function buildSlots(meshes) {
  const missing = [];
  (isShowcase ? showcasePlacements : allPlacements).forEach((spot) => {
    const failedSides = [];
    for (const side of new Set([spot.side, spot.mirror].filter(Boolean))) {
      if (!makeSlot(spot, side, meshes)) failedSides.push(side);
    }
    if (failedSides.length) missing.push({ id: spot.id, sides: failedSides });
  });
  if (isStudio) {
    window.dispatchEvent(new CustomEvent("studio:fit", {
      detail: { total: allPlacements.length, missing }
    }));
  }
}

/* --------------------------------------------------------------- model */
// Toes protrude further than heels: the side with the larger foot extent is the front.
function facesPositiveZ(meshes) {
  const extent = (dir) => {
    let best = 0;
    for (const x of [-0.1, 0.1]) {
      projector.set(new THREE.Vector3(x, 0.05, dir * 3), new THREE.Vector3(0, 0, -dir));
      const hit = projector.intersectObjects(meshes, false)[0];
      if (hit) best = Math.max(best, Math.abs(hit.point.z));
    }
    return best;
  };
  return extent(1) >= extent(-1);
}

function normalise(root) {
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  root.scale.setScalar(MODEL_HEIGHT / size.y);
  box.setFromObject(root);
  root.position.y -= box.min.y;
  root.position.x -= (box.min.x + box.max.x) / 2;
  root.position.z -= (box.min.z + box.max.z) / 2;
  root.updateMatrixWorld(true);
}

/* ------------------------------------------------------ sold sponsors */
function loadImage(src) {
  return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = src; });
}
const sponsorsReady = Promise.all(Object.entries(config.sold || {}).map(async ([id, entry]) => {
    if (!allPlacements.some((p) => p.id === id)) { console.warn(config.copy.unknownSponsorPlacement, id); return; }
    state.sold[id] = entry;
    if (entry.logo) {
      try { state.soldImages[id] = await loadImage(entry.logo); }
      catch { console.warn(config.copy.sponsorsLogoLoadError, id, entry.logo); }
    }
  }));

const modelUrl = new URLSearchParams(location.search).get("model") || config.model;
const isEmbedded = window.self !== window.top || new URLSearchParams(location.search).has("embed");
if (isEmbedded) document.documentElement.classList.add("is-embedded");
const draco = new DRACOLoader().setDecoderPath(`${THREE_ADDONS}libs/draco/`);
const loader = new GLTFLoader().setDRACOLoader(draco);
loader.load(
  modelUrl,
  (gltf) => {
    const root = gltf.scene;
    const meshes = [];
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = o.receiveShadow = true;
      o.material.metalness = 0;
      o.material.roughness = 0.9;
      o.material.side = THREE.FrontSide;
      if (o.material.map) { o.material.map.anisotropy = renderer.capabilities.getMaxAnisotropy(); o.material.map.needsUpdate = true; }
      meshes.push(o);
    });
    athlete.add(root);
    normalise(root);
    if (!facesPositiveZ(meshes)) { root.rotateY(Math.PI); normalise(root); }
    buildSlots(meshes);
    renderer.shadowMap.needsUpdate = true;
    firstRender().then(() => { stage.classList.add("is-ready"); playIntro(); });
  },
  (xhr) => {
    if (!xhr.total) return;
    const percent = Math.round((xhr.loaded / xhr.total) * 100);
    loadingEl.textContent = formatCopy(config.copy.modelLoadingProgress, { percent });
    loadBar?.style.setProperty("--progress", `${percent}%`);
  },
  (err) => {
    console.error(err);
    stage.classList.add("has-error");
    loadingEl.textContent = config.copy.modelLoadError;
    if (isStudio) window.dispatchEvent(new CustomEvent("studio:fit", { detail: { error: true } }));
    firstRender();
  }
);
// First paint once the sold list and live bids are known (used by both the model success and failure paths).
function firstRender() {
  return Promise.all([sponsorsReady, bidsReady]).then(() => { selectInitial(); renderAll(); scrollSelectedIntoView(); });
}
const LANDING_ORDER = ["front", "back", "lateral"].flatMap((view) => garments.flatMap((garment) =>
  garmentPlacements(garment).filter((spot) => view === "lateral" ? spot.side === "left" || spot.side === "right" : spot.side === view)
));
let linkedPlacement = null;
function selectInitial() {
  const wanted = decodeURIComponent(location.hash.slice(1)).toUpperCase();
  const eligible = isShowcase ? showcasePlacements : allPlacements;
  linkedPlacement = eligible.find((p) => p.id === wanted) || null;
  const spot = linkedPlacement || (isShowcase ? firstPlacement : LANDING_ORDER.find((p) => !isSold(p.id)) || firstPlacement);
  state.selected = spot?.id || null;
  state.garment = spot ? garmentOf(spot.id) : garments[0].id;
}

/* ----------------------------------------------------------- UI logic */
function currentSide() {
  const a = ((state.azimuth % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  if (a < Math.PI / 4 || a > Math.PI * 7 / 4) return "front";
  if (a > Math.PI * 3 / 4 && a < Math.PI * 5 / 4) return "back";
  return a < Math.PI ? "left" : "right";
}
function visiblePlacements() {
  const side = currentSide();
  const garment = garmentConfig(state.garment);
  const placements = garmentPlacements(garment);
  const onSide = placements.filter((spot) => spot.side === side);
  const lateral = placements.filter((spot) => spot.side === "left" || spot.side === "right");
  return [...onSide, ...lateral.filter((spot) => !onSide.includes(spot))];
}
const findPlacement = () => allPlacements.find((p) => p.id === state.selected) || (isShowcase ? null : allPlacements[0]);

function renderInventory() {
  const side = currentSide();
  const garment = garmentConfig(state.garment);
  const label = side === "front" ? config.copy.frontView : side === "back" ? config.copy.backView : garment.lateralLabel;
  inventoryTitle.textContent = `${garment.label} · ${label}`;
  document.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("is-active", b.dataset.view === side));
  availabilityEl.hidden = isShowcase;
  const items = visiblePlacements();
  inventoryList.replaceChildren();
  if (!items.length) {
    availabilityEl.innerHTML = ""; availabilityEl.classList.remove("is-full");
    const empty = document.createElement("p"); empty.className = "inventory-empty"; empty.textContent = config.copy.emptyInventory; inventoryList.append(empty); return;
  }
  const open = items.filter((s) => !isSold(s.id)).length;
  availabilityEl.innerHTML = `<i></i> ${formatCopy(config.copy.availabilityCount, { open, total: items.length })}`;
  availabilityEl.classList.toggle("is-full", open === 0);
  items.forEach((spot, index) => {
    const sold = state.sold[spot.id];
    const bid = state.bids[spot.id];
    const locked = !sold && (bid?.locked || bid?.closed);
    const button = document.createElement("button");
    button.className = `inventory-item${spot.id === state.selected ? " is-selected" : ""}${sold || locked ? " is-sold" : ""}`;
    const title = sold ? sold.sponsor : locked ? bid.lockedBy || bid.company || config.copy.lockedFallback : spot.name;
    const status = sold ? config.copy.soldStatus : locked ? (bid.locked ? config.copy.lockedStatus : config.copy.wonStatus)
      : bid?.high ? formatCopy(config.copy.statusBid, { amount: usd(bid.high) })
        : formatCopy(config.copy.statusOpen, { amount: usd(state.auction.minBid) });
    button.innerHTML = `<span class="num">${String(index + 1).padStart(2, "0")}</span><span><strong>${escapeHtml(title)}</strong><small>${spot.id}${sold || locked ? " · " + spot.name : ""}</small></span><span class="status">${status}</span>`;
    button.setAttribute("aria-pressed", String(spot.id === state.selected));
    button.addEventListener("click", () => selectPlacement(spot.id, true));
    inventoryList.append(button);
  });
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function scrollSelectedIntoView() {
  const el = inventoryList.querySelector(".inventory-item.is-selected");
  if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
const luminanceCache = new WeakMap();
function isDarkArtwork(img) {
  if (luminanceCache.has(img)) return luminanceCache.get(img);
  const c = document.createElement("canvas"); c.width = c.height = 32;
  const g = c.getContext("2d"); g.drawImage(img, 0, 0, 32, 32);
  const d = g.getImageData(0, 0, 32, 32).data;
  let sum = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { if (d[i + 3] > 40) { sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++; } }
  const dark = n > 0 && sum / n < 90;
  luminanceCache.set(img, dark);
  return dark;
}
function renderSelection() {
  const spot = findPlacement();
  if (!spot) {
    selectionCard.hidden = true;
    renderCalloutText();
    invalidate();
    return;
  }
  selectionCard.hidden = false;
  const sold = state.sold[spot.id];
  const bid = state.bids[spot.id];
  const locked = !sold && (bid?.locked || bid?.closed);
  const holder = locked ? bid.lockedBy || bid.company : null;
  selectionCode.textContent = spot.id;
  selectionStatus.textContent = sold ? config.copy.soldStatus : locked ? (bid.locked ? config.copy.lockedStatus : config.copy.wonStatus) : bid?.high ? config.copy.biddingStatus : config.copy.availableStatus;
  selectionCard.classList.toggle("is-sold", Boolean(sold || locked));
  selectionName.textContent = sold ? sold.sponsor : locked ? holder || config.copy.lockedInFallback : spot.name;
  selectionDescription.textContent = sold ? formatCopy(config.copy.soldDescription, { name: spot.name, sponsor: sold.sponsor })
    : locked ? formatCopy(config.copy.lockedDescription, {
      name: spot.name,
      status: bid.locked ? config.copy.placementLocked : config.copy.placementWon,
      holder: holder ? ` by ${holder}` : "",
      invoiceIssued: config.copy.invoiceIssued
    })
    : spot.detail;
  if (renderSelection.lastId !== spot.id) bidSuccess.hidden = true;
  renderSelection.lastId = spot.id;
  renderBidPanel(spot, bid);
  uploadLabel.textContent = state.logos[spot.id] ? config.copy.replaceLogo : config.copy.uploadLogo;
  const preview = state.logos[spot.id];
  previewThumb.hidden = !preview || Boolean(sold || locked);
  if (preview) previewImg.src = preview;
  const cardLogo = sold ? state.soldImages[spot.id] : locked ? state.bidImages[spot.id] : null;
  sponsorLogoEl.hidden = !cardLogo;
  if (cardLogo) {
    sponsorLogoEl.src = cardLogo.src;
    sponsorLogoEl.alt = `${sold ? sold.sponsor : holder || config.copy.sponsorFallback} logo`;
    sponsorLogoEl.classList.toggle("is-dark-art", isDarkArtwork(cardLogo));
  }
  const anyOpen = !isShowcase && allPlacements.some((p) => !isSold(p.id));
  openPlacementsBtn.hidden = isShowcase || !sold || !anyOpen;
  renderSpecs(spot);
  renderCalloutText();
  invalidate();
}
function renderSpecs(spot) {
  if (!specRow) return;
  const garment = garments.find((g) => g.placements.includes(spot));
  const sideLabel = config.copy[`${spot.side}View`];
  const specs = [["Print area", printSize(spot)], ["View", spot.mirror ? `${sideLabel} + ${config.copy[`${spot.mirror}View`]}` : sideLabel], ["Garment", garment?.label || ""]];
  specRow.replaceChildren(...specs.map(([label, value]) => {
    const el = document.createElement("div");
    el.className = "spec";
    el.innerHTML = `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>`;
    return el;
  }));
}
function renderSlots() { slotMeshes.forEach(drawSlot); }
function renderBidPanel(spot, bid) {
  const { minBid, increment, lockPrice, online, paymentsReady } = state.auction;
  const floor = minimumBid(spot.id);
  if (isDemo) {
    bidHigh.textContent = config.copy.noBids;
    bidMeta.textContent = `${formatCopy(config.copy.openingBid, { amount: usd(minBid) })} · ${config.demo.bidNotice}`;
  } else if (isStudio) {
    bidMeta.textContent = "Preview only — bidding is disabled";
  } else if (!paymentsReady) {
    bidMeta.textContent = config.copy.paymentsPending;
  } else if (bid?.high) {
    bidHigh.textContent = usd(bid.high);
    bidMeta.textContent = `${bid.company ? bid.company + " · " : ""}${bid.count} ${bid.count === 1 ? config.copy.bidCountOne : config.copy.bidCountMany} · ${online ? formatCopy(config.copy.nextBid, { amount: usd(floor) }) : config.copy.offline}`;
  } else {
    bidHigh.textContent = config.copy.noBids;
    bidMeta.textContent = online ? formatCopy(config.copy.openingBid, { amount: usd(minBid) }) : config.copy.offline;
  }
  const amount = bidForm.elements.amount;
  amount.min = floor; amount.step = increment; amount.placeholder = String(floor);
  const switched = renderBidPanel.last !== spot.id;
  if (switched || !amount.value || Number(amount.value) < floor) amount.value = floor;
  renderBidPanel.last = spot.id;
  lockPriceEl.textContent = usd(lockPrice);
  if (!submitBid.busy) {
    lockLabel.textContent = formatCopy(config.copy.lockLabel, { price: usd(lockPrice) });
    bidButton.disabled = lockButton.disabled = isStudio || isDemo || !online || !paymentsReady;
  }
  if (switched) bidError.hidden = true;
  if (state.auction.deadline && !isStudio && !isDemo) {
    const d = new Date(state.auction.deadline);
    bidNoteText.textContent = `${formatCopy(config.copy.bidNote, {
      minBid: usd(minBid),
      increment: usd(increment),
      closingDate: d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: config.event.timeZone })
    })} `;
  }
}
function renderGarments() {
  document.querySelectorAll(".garment-tab").forEach((b) => { const on = b.dataset.garment === state.garment; b.classList.toggle("is-active", on); b.setAttribute("aria-selected", String(on)); });
}
function renderOrientation() {
  const side = currentSide();
  orientationLabel.textContent = config.copy[`${side}View`].toUpperCase();
  const a = ((state.azimuth % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  orientationNeedle.style.left = `${(a / (Math.PI * 2)) * 100}%`;
}
function renderAll() { renderGarments(); renderSlots(); renderInventory(); renderSelection(); renderOrientation(); }

function selectPlacement(id, focus = false) {
  state.selected = id;
  state.garment = garmentOf(id);
  renderGarments(); renderSlots(); renderInventory(); renderSelection();
  if (!focus) scrollSelectedIntoView();
  if (focus) flyToPlacement(findPlacement());
}
function firstOpen(list) { return list.find((p) => !isSold(p.id))?.id || null; }
function setGarment(garment) {
  state.garment = garment;
  const g = garmentConfig(garment);
  const onThisSide = visiblePlacements(); // same rules as the inventory list (state.garment already updated)
  const spot = isShowcase
    ? garmentPlacements(g)[0]?.id || null
    : firstOpen(onThisSide) || firstOpen(g.placements) || firstOpen(allPlacements) || firstPlacement.id;
  state.selected = spot;
  const target = allPlacements.find((p) => p.id === spot);
  if (target && !onThisSide.some((p) => p.id === spot)) flyTo({ az: SIDE_AZIMUTH[target.side], ...homeFraming() });
  renderAll();
}

/* ----------------------------------------------------- camera control */
// One eased camera move at a time across azimuth, polar angle, distance and look-at height.
let tween = null;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const homeFraming = () => ({ polar: HOME.polar, dist: HOME.dist, targetY: HOME.targetY });
function cameraPose() {
  return { az: controls.getAzimuthalAngle(), polar: controls.getPolarAngle(), dist: camera.position.distanceTo(controls.target), targetY: controls.target.y };
}
function flyTo(to, { duration = 0.9, from = cameraPose(), onDone = null } = {}) {
  controls.autoRotate = false;
  const pose = { ...from, ...to };
  let dAz = pose.az - from.az; dAz = Math.atan2(Math.sin(dAz), Math.cos(dAz));
  if (prefersReducedMotion) duration = 0.001;
  tween = { from, delta: { az: dAz, polar: pose.polar - from.polar, dist: pose.dist - from.dist, targetY: pose.targetY - from.targetY }, t: 0, duration, onDone };
  invalidate();
}
function rotateTo(azimuth) { flyTo({ az: azimuth }, { duration: 0.75 }); }
function applyPose({ az, polar, dist, targetY }) {
  controls.target.y = targetY;
  camera.position.setFromSpherical(new THREE.Spherical(dist, polar, az)).add(controls.target);
  camera.lookAt(controls.target);
}
function stepTween(dt) {
  if (!tween) return;
  tween.t = Math.min(1, tween.t + dt / tween.duration);
  const e = easeInOut(tween.t);
  const { from, delta } = tween;
  applyPose({ az: from.az + delta.az * e, polar: from.polar + delta.polar * e, dist: from.dist + delta.dist * e, targetY: from.targetY + delta.targetY * e });
  invalidate();
  if (tween.t >= 1) {
    const done = tween.onDone;
    tween = null; lastSide = null; // re-run the visibility check once the move settles
    done?.();
  }
}
function slotFor(spot) {
  return slotMeshes.find((s) => s.spot.id === spot.id && s.side === spot.side) || slotMeshes.find((s) => s.spot.id === spot.id);
}
// Close-up on a placement: face its side and frame it at chest/hip height so the artwork reads clearly.
function flyToPlacement(spot) {
  const slot = slotFor(spot);
  const targetY = slot ? THREE.MathUtils.clamp(slot.point.y, 0.55, 1.5) : HOME.targetY;
  flyTo({ az: SIDE_AZIMUTH[spot.side], polar: 1.55, dist: 1.85, targetY }, { duration: 1.05 });
}
// Opening shot: start tight on the face, then pull back to the full athlete and begin a slow turntable.
function playIntro() {
  const spot = linkedPlacement;
  if (spot) { flyToPlacement(spot); return; }
  if (prefersReducedMotion) { invalidate(); return; }
  const from = { az: -0.75, polar: 1.5, dist: 1.25, targetY: 1.62 };
  applyPose(from);
  flyTo({ az: 0, ...homeFraming() }, { from, duration: 2.6, onDone: () => { if (!userInteracted) controls.autoRotate = true; } });
}
document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => flyTo({ az: SIDE_AZIMUTH[b.dataset.view], ...homeFraming() })));
canvas.addEventListener("dblclick", () => flyTo(homeFraming()));
document.getElementById("rotatePrev").addEventListener("click", () => rotateTo(controls.getAzimuthalAngle() - Math.PI / 4));
document.getElementById("rotateNext").addEventListener("click", () => rotateTo(controls.getAzimuthalAngle() + Math.PI / 4));
document.querySelectorAll(".garment-tab").forEach((b) => b.addEventListener("click", () => setGarment(b.dataset.garment)));

/* ------------------------------------------------------------ picking */
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downAt = null;
function pickSlot(e) {
  const rect = canvas.getBoundingClientRect();
  pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObjects(slotMeshes.map((s) => s.mesh), false)[0];
}
canvas.addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY]; });
canvas.addEventListener("pointerup", (e) => {
  if (!downAt) return;
  const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
  downAt = null;
  if (moved > 6) return;
  const hit = pickSlot(e);
  if (hit) selectPlacement(hit.object.userData.spotId);
});
function setHovered(id) {
  if (id === state.hovered) return;
  const prev = state.hovered;
  state.hovered = id;
  slotMeshes.forEach((s) => { if (s.spot.id === prev || s.spot.id === id) drawSlot(s); });
}
canvas.addEventListener("pointermove", (e) => {
  if (downAt) { setHovered(null); return; }
  const hit = pickSlot(e);
  canvas.style.cursor = hit ? "pointer" : "grab";
  setHovered(hit ? hit.object.userData.spotId : null);
});
canvas.addEventListener("pointerleave", () => setHovered(null));
canvas.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft") { e.preventDefault(); rotateTo(controls.getAzimuthalAngle() - Math.PI / 4); }
  if (e.key === "ArrowRight") { e.preventDefault(); rotateTo(controls.getAzimuthalAngle() + Math.PI / 4); }
});

/* ------------------------------------------------------- logo upload */
document.getElementById("logoInput").addEventListener("change", (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file || isSold(state.selected)) return;
  if (!file.type.startsWith("image/")) { toast(config.copy.logoUnsupported); return; }
  if (file.size > 5 * 1024 * 1024) { toast(config.copy.logoTooLarge); return; }
  const id = state.selected;
  const old = state.logos[id];
  if (old) URL.revokeObjectURL(old);
  const url = URL.createObjectURL(file);
  state.logos[id] = url;
  const img = new Image();
  img.onload = () => { state.logoImages[id] = img; renderSlots(); renderSelection(); };
  img.onerror = () => { delete state.logos[id]; URL.revokeObjectURL(url); toast(config.copy.logoUnreadable); renderSelection(); };
  img.src = url;
});
removePreview.addEventListener("click", () => {
  const id = state.selected;
  if (state.logos[id]) URL.revokeObjectURL(state.logos[id]);
  delete state.logos[id]; delete state.logoImages[id];
  renderSlots(); renderSelection();
});
openPlacementsBtn.addEventListener("click", () => {
  const visible = visiblePlacements().find((p) => !isSold(p.id));
  const next = visible || garmentConfig(state.garment).placements.find((p) => !isSold(p.id)) || allPlacements.find((p) => !isSold(p.id));
  if (!next) return;
  selectPlacement(next.id, true);
});
/* ------------------------------------------------------------ bidding */
async function loadBids() {
  if (isStudio || isShowcase || isDemo) return;
  try {
    const res = await fetch(BIDS_URL, { cache: "no-store", headers: previewHeaders, signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(8000) : undefined });
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    state.auction = { minBid: data.minBid, increment: data.increment, lockPrice: data.lockPrice, deadline: data.deadline, online: true, paymentsReady: data.paymentsReady ?? true };
    state.bids = data.placements || {};
    await loadBidLogos();
  } catch (err) {
    console.warn("bids unavailable", err);
    state.auction.online = false;
  }
  renderSlots(); renderInventory(); renderSelection();
}
async function loadBidLogos() {
  await Promise.all(Object.values(state.bids).map(async (b) => {
    if (!b.logo) { delete state.bidImages[b.id]; return; }
    const logoUrl = new URL(b.logo, location.href);
    if (config.previewToken) logoUrl.searchParams.set("preview", config.previewToken);
    const url = logoUrl.href;
    if (state.bidImages[b.id]?.src === url) return;
    try { state.bidImages[b.id] = await loadImage(url); }
    catch { console.warn("Bidder logo failed to load", b.id); }
  }));
}
// Gate the first render on live bids so we never land on a locked placement, but only briefly:
// a slow or stalled API must not keep the viewer hidden. Polling keeps refreshing afterwards.
const bidsReady = isStudio || isShowcase || isDemo ? Promise.resolve() : Promise.race([loadBids(), new Promise((r) => setTimeout(r, 4000))]);
if (!isStudio && !isShowcase && !isDemo) setInterval(loadBids, 30000);

// Rasterise the previewed logo (max 800px, PNG) so it travels with the bid and survives a refresh.
function logoDataUrl(id) {
  const img = state.logoImages[id];
  if (!img) return null;
  const k = Math.min(1, 800 / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round((img.naturalWidth || img.width) * k)); c.height = Math.max(1, Math.round((img.naturalHeight || img.height) * k));
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  try { return c.toDataURL("image/png"); } catch { return null; }
}
function showBidError(message) { bidError.textContent = message; bidError.hidden = false; }
function showBidSuccess(spot, data, locked, email) {
  bidSuccessLink.hidden = !data.invoiceUrl;
  if (data.invoiceUrl) bidSuccessLink.href = data.invoiceUrl;
  if (locked) {
    bidSuccessTitle.textContent = formatCopy(config.copy.successLockedTitle, { id: spot.id });
    bidSuccessText.textContent = data.invoiceUrl
      ? formatCopy(config.copy.successInvoiceReady, {
        price: usd(state.auction.lockPrice),
        emailed: data.emailed ? formatCopy(config.copy.successInvoiceEmailSuffix, { email }) : "",
        firstName: config.athlete.firstName
      })
      : formatCopy(config.copy.successInvoicePending, { firstName: config.athlete.firstName, price: usd(state.auction.lockPrice), email });
  } else {
    bidSuccessTitle.textContent = formatCopy(config.copy.successHighBidTitle, { amount: usd(data.placement.high) });
    bidSuccessText.textContent = formatCopy(config.copy.successBidConfirmation, {
      email,
      logo: state.logoImages[spot.id] ? ` ${config.copy.successLogoSaved}` : "",
      successOutro: config.copy.successOutro
    });
  }
  bidSuccess.hidden = false;
  bidSuccess.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
async function submitBid(type) {
  if (isStudio || isShowcase || isDemo) return;
  const spot = findPlacement();
  if (isSold(spot.id)) return;
  const f = bidForm.elements;
  const payload = { id: spot.id, type, company: f.company.value.trim(), name: f.name.value.trim(), email: f.email.value.trim(), phone: f.phone.value.trim(), amount: Number(f.amount.value), logo: logoDataUrl(spot.id) };
  if (!payload.company || !payload.name) return showBidError(config.copy.missingContact);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) return showBidError(config.copy.invalidEmail);
  if (type === "bid" && (!Number.isFinite(payload.amount) || payload.amount < minimumBid(spot.id))) return showBidError(formatCopy(config.copy.bidTooLow, { amount: usd(minimumBid(spot.id)) }));
  if (type === "lock" && !confirm(formatCopy(config.copy.lockConfirmation, {
    id: spot.id, name: spot.name, price: usd(state.auction.lockPrice), email: payload.email
  }))) return;
  bidError.hidden = true;
  submitBid.busy = true;
  bidSuccess.hidden = true;
  bidButton.disabled = lockButton.disabled = true;
  const busy = type === "lock" ? lockLabel : bidButton;
  const label = busy.textContent; busy.textContent = config.copy.sending;
  try {
    const res = await fetch(BIDS_URL, { method: "POST", headers: { "content-type": "application/json", ...previewHeaders }, body: JSON.stringify(payload) });
    const data = await res.json().catch(() => ({}));
    if (data.placement) { state.bids[spot.id] = data.placement; await loadBidLogos(); }
    if (!res.ok) { showBidError(data.error || config.copy.saveFailed); renderSlots(); renderInventory(); renderSelection(); return; }
    const locked = Boolean(data.placement?.locked);
    renderSlots(); renderInventory(); renderSelection();
    showBidSuccess(spot, data, locked, payload.email);
    toast(locked
      ? formatCopy(config.copy.toastLocked, { id: spot.id, price: usd(state.auction.lockPrice) })
      : formatCopy(config.copy.toastHighBid, { id: spot.id, amount: usd(data.placement.high) }));
  } catch (err) {
    console.error(err);
    showBidError(config.copy.networkError);
  } finally {
    submitBid.busy = false;
    busy.textContent = label;
    bidButton.disabled = lockButton.disabled = !state.auction.online || !state.auction.paymentsReady;
  }
}
bidForm.addEventListener("submit", (e) => { e.preventDefault(); if (!isStudio && !isShowcase) submitBid("bid"); });
lockButton.addEventListener("click", () => { if (!isShowcase) submitBid("lock"); });

// Hash edits after load (e.g. the host page forwarding a new /#ID into the embed) select that placement.
window.addEventListener("hashchange", () => {
  const spot = (isShowcase ? showcasePlacements : allPlacements)
    .find((p) => p.id === decodeURIComponent(location.hash.slice(1)).toUpperCase());
  if (spot) selectPlacement(spot.id, true);
});

/* ------------------------------------------------------- fight poster */
const posterDialog = document.getElementById("posterDialog");
if (posterDialog) {
  document.getElementById("posterButton").addEventListener("click", () => posterDialog.showModal());
  document.getElementById("posterClose").addEventListener("click", () => posterDialog.close());
  posterDialog.addEventListener("click", (e) => { if (e.target === posterDialog) posterDialog.close(); });
}

/* -------------------------------------------------------------- embed */
const embedDialog = document.getElementById("embedDialog");
document.getElementById("embedButton").addEventListener("click", () => embedDialog.showModal());
document.getElementById("dialogClose").addEventListener("click", () => embedDialog.close());
embedDialog.addEventListener("click", (e) => { if (e.target === embedDialog) embedDialog.close(); });
const embedCodeEl = document.getElementById("embedCode");
if (location.protocol.startsWith("http") && !/^(localhost|127\.)/.test(location.hostname)) {
  embedCodeEl.textContent = embedCodeEl.textContent.replace("YOUR-PORTAL-URL", `${location.origin}${location.pathname}`);
}
const copyButton = document.getElementById("copyEmbed");
copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(embedCodeEl.textContent);
    copyButton.textContent = config.copy.embedCopied;
  } catch {
    const range = document.createRange(); range.selectNodeContents(embedCodeEl);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    copyButton.textContent = config.copy.embedCopyHint;
  }
  setTimeout(() => { copyButton.textContent = config.copy.copyEmbed; }, 1800);
});

/* ------------------------------------------------------- host sizing */
if (isEmbedded) {
  let lastHeight = 0;
  const postHeight = () => {
    // Measure the body, not documentElement.scrollHeight: the latter is never smaller than the
    // iframe viewport, so the host frame could grow but never shrink back to the content.
    const height = Math.ceil(document.body.getBoundingClientRect().height);
    if (height === lastHeight) return;
    lastHeight = height;
    window.parent.postMessage({ type: "heck-portal-height", height }, "*");
  };
  new ResizeObserver(postHeight).observe(document.body);
  window.addEventListener("load", postHeight);
  postHeight();
}

/* --------------------------------------------------------------- loop */
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  invalidate();
}
new ResizeObserver(resize).observe(stage);
resize();
let stageVisible = true;
new IntersectionObserver(([entry]) => { stageVisible = entry.isIntersecting; if (stageVisible) invalidate(); }).observe(stage);

// Adaptive resolution: if sustained frame time is too slow, step the pixel ratio down (never below 1).
const frameTimes = [];
let lastFrameAt = 0;
function sampleFrame(now) {
  if (lastFrameAt && now - lastFrameAt < 1000) frameTimes.push(now - lastFrameAt);
  lastFrameAt = now;
  if (frameTimes.length < 45) return;
  frameTimes.sort((a, b) => a - b);
  const median = frameTimes[Math.floor(frameTimes.length / 2)];
  frameTimes.length = 0;
  if (median > 24 && pixelRatio > 1) {
    pixelRatio = Math.max(1, pixelRatio - 0.25);
    renderer.setPixelRatio(pixelRatio);
    resize();
  }
}

/* ---------------------------------------------- selected-placement callout */
const callout = document.createElement("div");
callout.className = "spot-callout";
callout.setAttribute("aria-hidden", "true");
callout.innerHTML = `<i class="spot-callout-dot"></i><span class="spot-callout-line"></span><div class="spot-callout-card"><span class="spot-callout-code"></span><strong class="spot-callout-name"></strong><small class="spot-callout-meta"></small></div>`;
stage.append(callout);
const calloutCode = callout.querySelector(".spot-callout-code");
const calloutName = callout.querySelector(".spot-callout-name");
const calloutMeta = callout.querySelector(".spot-callout-meta");
const projected = new THREE.Vector3();
const toCamera = new THREE.Vector3();
function renderCalloutText() {
  const spot = findPlacement();
  if (!spot) {
    callout.classList.remove("is-visible");
    return;
  }
  const sold = state.sold[spot.id];
  const bid = state.bids[spot.id];
  calloutCode.textContent = `${spot.id} · ${printSize(spot)}`;
  calloutName.textContent = sold ? sold.sponsor : spot.name;
  calloutMeta.textContent = sold ? config.copy.soldStatus
    : bid?.locked || bid?.closed ? (bid.locked ? config.copy.lockedStatus : config.copy.wonStatus)
      : bid?.high ? formatCopy(config.copy.statusBid, { amount: usd(bid.high) })
        : formatCopy(config.copy.statusOpen, { amount: usd(state.auction.minBid) });
  callout.classList.toggle("is-sold", Boolean(sold || bid?.locked || bid?.closed));
}
function positionCallout() {
  const spot = findPlacement();
  const slot = spot ? slotFor(spot) : null;
  const ready = stage.classList.contains("is-ready") && !(tween && tween.duration > 2);
  if (!slot || !ready) { callout.classList.remove("is-visible"); return; }
  toCamera.copy(camera.position).sub(slot.point).normalize();
  projected.copy(slot.point).project(camera);
  const facing = slot.normal.dot(toCamera) > 0.25 && projected.z < 1;
  const w = stage.clientWidth, h = stage.clientHeight;
  const x = (projected.x * 0.5 + 0.5) * w, y = (-projected.y * 0.5 + 0.5) * h;
  const inside = x > 0 && x < w && y > 0 && y < h;
  callout.classList.toggle("is-visible", facing && inside);
  callout.classList.toggle("is-left", x > w * 0.5);
  callout.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
}
// Approximate printed size on a 1.86 m athlete; final artwork dimensions are confirmed with the sponsor.
function printSize(spot) {
  const inches = (m) => (m * 39.37).toFixed(1).replace(/\.0$/, "");
  return `≈ ${inches(spot.w)} × ${inches(spot.h)} in`;
}

let lastSide = null;
const clock = new THREE.Clock();
function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (!stageVisible || document.hidden) { lastFrameAt = 0; return; }
  stepTween(dt);
  controls.update(dt);
  if (!needsRender) { lastFrameAt = 0; return; }
  needsRender = false;
  state.azimuth = controls.getAzimuthalAngle();
  const side = currentSide();
  if (side !== lastSide) {
    lastSide = side;
    const visible = visiblePlacements();
    // Do not re-select while a programmatic move is carrying the user to a chosen placement.
    const open = !tween && visible.length && !visible.some((p) => p.id === state.selected) ? firstOpen(visible) : null;
    if (open) { state.selected = open; renderSlots(); renderSelection(); }
    renderInventory();
  }
  renderOrientation();
  renderer.render(scene, camera);
  positionCallout();
  if (now) sampleFrame(now);
}
renderAll();
requestAnimationFrame(animate);
