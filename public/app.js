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
const THREE_CDN = "https://unpkg.com/three@0.170.0/examples/jsm/";
const config = JSON.parse(document.getElementById("portal-config").textContent);
const garments = config.garments;
const allPlacements = garments.flatMap((garment) => garment.placements);
const garmentConfig = (id) => garments.find((garment) => garment.id === id);
const garmentOf = (id) => garments.find((garment) => garment.placements.some((spot) => spot.id === id))?.id || garments[0].id;
const firstPlacement = allPlacements[0];
const accentColor = new THREE.Color(config.brand.accent);
const formatCopy = (template, values = {}) => String(template).replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_, key) => values[key] ?? "");

const SIDE_AZIMUTH = { front: 0, back: Math.PI, left: Math.PI / 2, right: -Math.PI / 2 };
const state = { garment: garments[0].id, selected: firstPlacement.id, hovered: null, logos: {}, logoImages: {}, sold: {}, soldImages: {}, bidImages: {}, azimuth: 0, bids: {}, auction: { minBid: config.pricing.minBid, increment: config.pricing.increment, lockPrice: config.pricing.lockPrice, deadline: config.pricing.deadline, online: false } };
const BIDS_URL = "/api/bids";
const isLocked = (id) => Boolean(state.bids[id]?.locked || state.bids[id]?.closed);
const isSold = (id) => Boolean(state.sold[id]) || isLocked(id);
const usd = (n) => new Intl.NumberFormat("en-US", { style: "currency", currency: config.pricing.currency.toUpperCase(), maximumFractionDigits: 0 }).format(Math.round(n));
const minimumBid = (id) => { const b = state.bids[id]; return Math.max(state.auction.minBid, b?.high ? b.high + state.auction.increment : 0); };

/* ------------------------------------------------------------------ DOM */
const stage = document.getElementById("modelStage");
const canvas = document.getElementById("viewer");
const loadingEl = document.getElementById("loadingText");
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
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.7;

const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 40);
const TARGET = new THREE.Vector3(0, 1.0, 0);
camera.position.set(0, 1.05, 3.3);

const controls = new OrbitControls(camera, canvas);
controls.target.copy(TARGET);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.minDistance = 1.2;
controls.maxDistance = ROPE_RADIUS - 0.2; // stay inside the ropes
controls.minPolarAngle = 0.9;
controls.maxPolarAngle = 1.75;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.9;
controls.addEventListener("start", () => { controls.autoRotate = false; });

const arena = buildArena(scene, config.ring);

const key = new THREE.DirectionalLight(0xfff1e0, 2.2);
key.position.set(2.5, 4.5, 3.5);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 1; key.shadow.camera.far = 12;
key.shadow.camera.left = key.shadow.camera.bottom = -1.6;
key.shadow.camera.right = key.shadow.camera.top = 1.6;
key.shadow.bias = -0.0005; key.shadow.normalBias = 0.03;
key.shadow.radius = 4;
scene.add(key);
const rim = new THREE.DirectionalLight(accentColor, 1.2);
rim.position.set(-3, 2.2, -3.5);
scene.add(rim);
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
  tex.anisotropy = 8;
  return { canvas: c, tex };
}
function drawSlot(slot) {
  const { spot, canvas: c, tex } = slot;
  const g = c.getContext("2d");
  const selected = spot.id === state.selected;
  const hovered = spot.id === state.hovered && !selected;
  g.clearRect(0, 0, c.width, c.height);
  const soldImg = state.soldImages[spot.id] || (isLocked(spot.id) ? state.bidImages[spot.id] : null);
  if (soldImg) {
    const pad = 6, bw = c.width - pad * 2, bh = c.height - pad * 2;
    const k = Math.min(bw / soldImg.width, bh / soldImg.height);
    g.drawImage(soldImg, (c.width - soldImg.width * k) / 2, (c.height - soldImg.height * k) / 2, soldImg.width * k, soldImg.height * k);
    if (selected || hovered) { g.lineWidth = 8; g.strokeStyle = selected ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.4)"; roundRect(g, 5, 5, c.width - 10, c.height - 10, 16); g.stroke(); }
    tex.needsUpdate = true;
    return;
  }
  const img = state.logoImages[spot.id];
  if (img) {
    g.fillStyle = "rgba(255,255,255,0.96)";
    roundRect(g, 6, 6, c.width - 12, c.height - 12, 14); g.fill();
    const pad = 22, bw = c.width - pad * 2, bh = c.height - pad * 2;
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
  if (selected) { g.lineWidth = 10; g.strokeStyle = config.brand.accent; roundRect(g, 5, 5, c.width - 10, c.height - 10, 16); g.stroke(); }
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
  const slot = { spot, mesh, canvas: c, tex };
  slotMeshes.push(slot);
  drawSlot(slot);
  return slot;
}

function buildSlots(meshes) {
  allPlacements.forEach((spot) => {
    makeSlot(spot, spot.side, meshes);
    if (spot.mirror) makeSlot(spot, spot.mirror, meshes);
  });
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
const draco = new DRACOLoader().setDecoderPath(`${THREE_CDN}libs/draco/`);
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
    firstRender().then(() => stage.classList.add("is-ready"));
  },
  (xhr) => {
    if (xhr.total) loadingEl.textContent = formatCopy(config.copy.modelLoadingProgress, { percent: Math.round((xhr.loaded / xhr.total) * 100) });
  },
  (err) => {
    console.error(err);
    stage.classList.add("has-error");
    loadingEl.textContent = config.copy.modelLoadError;
    firstRender();
  }
);
// First paint once the sold list and live bids are known (used by both the model success and failure paths).
function firstRender() {
  return Promise.all([sponsorsReady, bidsReady]).then(() => { selectInitial(); renderAll(); scrollSelectedIntoView(); });
}
const LANDING_ORDER = ["front", "back", "lateral"].flatMap((view) => garments.flatMap((garment) =>
  garment.placements.filter((spot) => view === "lateral" ? spot.side === "left" || spot.side === "right" : spot.side === view)
));
function selectInitial() {
  const wanted = decodeURIComponent(location.hash.slice(1)).toUpperCase();
  const linked = allPlacements.find((p) => p.id === wanted);
  const spot = linked || LANDING_ORDER.find((p) => !isSold(p.id)) || firstPlacement;
  state.selected = spot.id;
  state.garment = garmentOf(spot.id);
  if (linked || currentSide() !== spot.side) rotateTo(SIDE_AZIMUTH[spot.side]);
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
  const onSide = garment.placements.filter((spot) => spot.side === side);
  const lateral = garment.placements.filter((spot) => spot.side === "left" || spot.side === "right");
  return [...onSide, ...lateral.filter((spot) => !onSide.includes(spot))];
}
const findPlacement = () => allPlacements.find((p) => p.id === state.selected) || allPlacements[0];

function renderInventory() {
  const side = currentSide();
  const garment = garmentConfig(state.garment);
  const label = side === "front" ? config.copy.frontView : side === "back" ? config.copy.backView : garment.lateralLabel;
  inventoryTitle.textContent = `${garment.label} · ${label}`;
  document.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("is-active", b.dataset.view === side));
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
  const anyOpen = allPlacements.some((p) => !isSold(p.id));
  openPlacementsBtn.hidden = !sold || !anyOpen;
}
function renderSlots() { slotMeshes.forEach(drawSlot); }
function renderBidPanel(spot, bid) {
  const { minBid, increment, lockPrice, online } = state.auction;
  const floor = minimumBid(spot.id);
  if (bid?.high) {
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
    bidButton.disabled = lockButton.disabled = !online;
  }
  if (switched) bidError.hidden = true;
  if (state.auction.deadline) {
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
  if (focus) {
    const spot = findPlacement();
    const cur = state.azimuth;
    let delta = SIDE_AZIMUTH[spot.side] - cur; delta = Math.atan2(Math.sin(delta), Math.cos(delta));
    if (Math.abs(delta) > 0.6) rotateTo(cur + delta);
  }
}
function firstOpen(list) { return list.find((p) => !isSold(p.id))?.id || null; }
function setGarment(garment) {
  state.garment = garment;
  const g = garmentConfig(garment);
  const onThisSide = visiblePlacements(); // same rules as the inventory list (state.garment already updated)
  const spot = firstOpen(onThisSide) || firstOpen(g.placements) || firstOpen(allPlacements) || firstPlacement.id;
  state.selected = spot;
  const target = allPlacements.find((p) => p.id === spot);
  if (target && !onThisSide.some((p) => p.id === spot)) rotateTo(SIDE_AZIMUTH[target.side]);
  renderAll();
}

/* ----------------------------------------------------- camera control */
let tween = null;
function rotateTo(azimuth) {
  controls.autoRotate = false;
  const dist = camera.position.distanceTo(controls.target);
  const polar = controls.getPolarAngle();
  const start = controls.getAzimuthalAngle();
  let end = azimuth; let d = end - start; d = Math.atan2(Math.sin(d), Math.cos(d));
  tween = { start, delta: d, polar, dist, t: 0 };
}
function applyAzimuth(az, polar, dist) {
  const s = new THREE.Spherical(dist, polar, az);
  camera.position.setFromSpherical(s).add(controls.target);
  camera.lookAt(controls.target);
}
document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => rotateTo(SIDE_AZIMUTH[b.dataset.view])));
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
  try {
    const res = await fetch(BIDS_URL, { cache: "no-store", signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(8000) : undefined });
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    state.auction = { minBid: data.minBid, increment: data.increment, lockPrice: data.lockPrice, deadline: data.deadline, online: true };
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
    const url = new URL(b.logo, location.href).href;
    if (state.bidImages[b.id]?.src === url) return;
    try { state.bidImages[b.id] = await loadImage(url); }
    catch { console.warn("Bidder logo failed to load", b.id); }
  }));
}
// Gate the first render on live bids so we never land on a locked placement, but only briefly:
// a slow or stalled API must not keep the viewer hidden. Polling keeps refreshing afterwards.
const bidsReady = Promise.race([loadBids(), new Promise((r) => setTimeout(r, 4000))]);
setInterval(loadBids, 30000);

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
    const res = await fetch(BIDS_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
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
    bidButton.disabled = lockButton.disabled = !state.auction.online;
  }
}
bidForm.addEventListener("submit", (e) => { e.preventDefault(); submitBid("bid"); });
lockButton.addEventListener("click", () => submitBid("lock"));

// Hash edits after load (e.g. the host page forwarding a new /#ID into the embed) select that placement.
window.addEventListener("hashchange", () => {
  const spot = allPlacements.find((p) => p.id === decodeURIComponent(location.hash.slice(1)).toUpperCase());
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
}
new ResizeObserver(resize).observe(stage);
resize();

let lastSide = null;
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (tween) {
    tween.t = Math.min(1, tween.t + dt * 2.2);
    const e = 1 - Math.pow(1 - tween.t, 3);
    applyAzimuth(tween.start + tween.delta * e, tween.polar, tween.dist);
    if (tween.t >= 1) { tween = null; lastSide = null; } // re-run the visibility check once the rotation settles
  }
  controls.update();
  arena.update(clock.elapsedTime);
  state.azimuth = controls.getAzimuthalAngle();
  const side = currentSide();
  if (side !== lastSide) {
    lastSide = side;
    const visible = visiblePlacements();
    // Do not re-select while a programmatic rotation is carrying the user to a chosen placement.
    const open = !tween && visible.length && !visible.some((p) => p.id === state.selected) ? firstOpen(visible) : null;
    if (open) { state.selected = open; renderSlots(); renderSelection(); }
    renderInventory();
  }
  renderOrientation();
  renderer.render(scene, camera);
}
renderAll();
animate();
