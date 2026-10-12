import * as THREE from "three";

/* ------------------------------------------------------------ walkout robe */
// A satin boxing robe built from the athlete's own rig and body, skinned to the same skeleton so it follows every move.
// The body (with sleeves cut at mid-forearm) is lofted from the torso's cross-sections in the pose it is built in:
// each horizontal slice of the torso and thighs is wrapped in its convex hull plus a little ease, the skirt flares to
// just above the knee, a belt cinches the waist and a shawl collar opens into a V. Sleeves are tubes along the arm
// bones, capped over the shoulder. Placement IDs never depend on this geometry: sponsors' decals are projected onto it
// exactly as they are onto the body.

const TORSO = /^(Hips|Spine\d*|neck|(Left|Right)Shoulder|(Left|Right)UpLeg)$/;
const SLICE = 0.015;      // metres between torso slices
const AROUND = 96;        // columns around the robe
const EASE = 0.024;       // clearance between the skin and the satin
const FLARE = 0.05;       // extra skirt ease per metre below the belt
const TRIM = 0.05;        // collar, hem and cuff trim width (metres)

const smooth = (a, b, x) => { const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// Convex hull (monotone chain) of [x, z] points, counter-clockwise.
function hull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), q) <= 0) lower.pop(); lower.push(q); }
  for (const q of p.reverse()) { while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

// Distance from `c` to the hull boundary along the direction (dx, dz).
function hullRadius(poly, c, dx, dz) {
  let best = 0;
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i], [bx, bz] = poly[(i + 1) % poly.length];
    const ex = bx - ax, ez = bz - az, den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((ax - c[0]) * ez - (az - c[1]) * ex) / den;
    const u = ((ax - c[0]) * dz - (az - c[1]) * dx) / den;
    if (t > 0 && u >= -1e-6 && u <= 1 + 1e-6) best = Math.max(best, t);
  }
  return best;
}

// Smooths a ring (wrapping) or a column of numbers in place with a [1, 2, 1] kernel.
function blur(values, passes, wrap) {
  for (let p = 0; p < passes; p++) {
    const v = values.slice();
    for (let i = 0; i < v.length; i++) {
      const a = wrap ? v[(i - 1 + v.length) % v.length] : v[Math.max(0, i - 1)];
      const b = wrap ? v[(i + 1) % v.length] : v[Math.min(v.length - 1, i + 1)];
      values[i] = (a + 2 * v[i] + b) / 4;
    }
  }
}

// Posed world positions and per-vertex membership of the body, with a coarse spatial hash for nearest lookups.
function bodyIndex(body) {
  body.updateMatrixWorld(true);
  body.skeleton.update();
  const { position, skinIndex, skinWeight } = body.geometry.attributes;
  const n = position.count, world = new Float32Array(n * 3), v = new THREE.Vector3();
  for (let i = 0; i < n; i++) body.getVertexPosition(i, v).applyMatrix4(body.matrixWorld).toArray(world, i * 3);
  const bones = body.skeleton.bones;
  const weightOn = (i, pattern) => {
    let w = 0;
    for (let k = 0; k < 4; k++) if (pattern.test(bones[skinIndex.getComponent(i, k)]?.name || "")) w += skinWeight.getComponent(i, k);
    return w;
  };
  const CELL = 0.03;
  const key = (x, y, z) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`;
  function members(pattern) {
    const ids = [];
    for (let i = 0; i < n; i++) if (weightOn(i, pattern) > 0.5) ids.push(i);
    return ids;
  }
  // Grids of chosen vertex sets, for the skin weights of nearby robe vertices.
  function grid(ids) {
    const g = new Map();
    for (const i of ids) {
      const k = key(world[i * 3], world[i * 3 + 1], world[i * 3 + 2]);
      let list = g.get(k);
      if (!list) g.set(k, (list = []));
      list.push(i);
    }
    return g;
  }
  // Skin influences of the K nearest vertices in `g`, blended by inverse squared distance.
  function weightsNear(g, p, K = 8) {
    const cx = Math.floor(p.x / CELL), cy = Math.floor(p.y / CELL), cz = Math.floor(p.z / CELL);
    for (let r = 1; r <= 6; r++) {
      const found = [];
      for (let x = cx - r; x <= cx + r; x++) for (let y = cy - r; y <= cy + r; y++) for (let z = cz - r; z <= cz + r; z++) {
        for (const i of g.get(`${x},${y},${z}`) || []) {
          const d = (world[i * 3] - p.x) ** 2 + (world[i * 3 + 1] - p.y) ** 2 + (world[i * 3 + 2] - p.z) ** 2;
          found.push([d, i]);
        }
      }
      if (found.length < K && r < 6) continue;
      found.sort((a, b) => a[0] - b[0]);
      const influence = new Map();
      for (const [d, i] of found.slice(0, K)) {
        const w0 = 1 / (d + 1e-5);
        for (let k = 0; k < 4; k++) {
          const w = skinWeight.getComponent(i, k) * w0;
          if (w > 0) influence.set(skinIndex.getComponent(i, k), (influence.get(skinIndex.getComponent(i, k)) || 0) + w);
        }
      }
      return influence;
    }
    return new Map();
  }
  return { world, members, grid, weightsNear };
}

function canvasTexture(width, height, draw, anisotropy) {
  const c = document.createElement("canvas");
  c.width = width; c.height = height;
  draw(c.getContext("2d"), width, height);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  return tex;
}

// Builds the robe for `body` (the athlete's SkinnedMesh, posed as it should be fitted), or null if the rig lacks the
// bones. `colors` are the satin and trim colours.
export function buildRobe(body, { color = "#0d0d10", trim = "#c8102e", anisotropy = 1 } = {}) {
  const bone = (name) => body.skeleton.bones.find((b) => b.name === name);
  const needed = ["Hips", "Spine02", "Spine01", "neck", "Head", ...["Left", "Right"].flatMap((s) => [`${s}Arm`, `${s}ForeArm`, `${s}Hand`, `${s}Leg`])];
  if (!needed.every(bone)) return null;
  const index = bodyIndex(body);
  const at = (name) => bone(name).getWorldPosition(new THREE.Vector3());
  const { world } = index;

  /* ---- body loft */
  const hips = at("Hips"), knees = (at("LeftLeg").y + at("RightLeg").y) / 2;
  const hemY = knees + 0.05;
  const beltY = THREE.MathUtils.lerp(hips.y, at("Spine02").y, 0.55);
  const vBottom = at("Spine01").y + 0.02;
  const topY = THREE.MathUtils.lerp(at("neck").y, at("Head").y, 0.75);
  const V_WIDTH = THREE.MathUtils.degToRad(58);
  const neckline = (theta) => topY - (topY - vBottom) * Math.max(0, 1 - Math.abs(theta) / V_WIDTH);

  const torso = index.members(TORSO);
  const slices = Math.ceil((topY - hemY) / SLICE) + 1;
  const bins = Array.from({ length: slices }, () => []);
  for (const i of torso) {
    const s = Math.round((world[i * 3 + 1] - hemY) / SLICE);
    for (const t of [s - 1, s, s + 1]) if (t >= 0 && t < slices) bins[t].push([world[i * 3], world[i * 3 + 2]]);
  }
  // Each slice: its hull's centre and radius around the robe, with ease, the skirt's flare and the belt.
  const centres = [], radii = [];
  for (let s = 0; s < slices; s++) {
    const poly = hull(bins[s]);
    if (poly.length < 3) { centres.push(centres.at(-1) || [hips.x, hips.z]); radii.push(radii.at(-1)?.slice() || Array(AROUND).fill(0.15)); continue; }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of poly) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
    const c = [(minX + maxX) / 2, (minZ + maxZ) / 2];
    centres.push(c);
    radii.push(Array.from({ length: AROUND }, (_, k) => {
      const theta = -Math.PI + (2 * Math.PI * k) / AROUND;
      return hullRadius(poly, c, Math.sin(theta), Math.cos(theta));
    }));
  }
  // One shared axis per slice, drifting smoothly with the body (a slice's own box centre jumps at the armpits).
  for (const axis of [0, 1]) {
    const column = centres.map((c) => c[axis]);
    blur(column, 12, false);
    centres.forEach((c, s) => {
      const shift = column[s] - c[axis];
      // Re-express the radii about the smoothed centre.
      for (let k = 0; k < AROUND; k++) {
        const theta = -Math.PI + (2 * Math.PI * k) / AROUND;
        radii[s][k] -= shift * (axis === 0 ? Math.sin(theta) : Math.cos(theta));
      }
      c[axis] = column[s];
    });
  }
  for (let s = 0; s < slices; s++) {
    const y = hemY + s * SLICE;
    const flare = y < beltY ? FLARE * (beltY - y) : 0;
    for (let k = 0; k < AROUND; k++) radii[s][k] = Math.max(radii[s][k], 0.03) + EASE + flare;
    blur(radii[s], 3, true);
  }
  for (let k = 0; k < AROUND; k++) {
    const column = radii.map((r) => r[k]);
    // Light vertical smoothing: more would carry the shoulders' width up into the collar.
    blur(column, 1, false);
    // Below the belt the satin drapes: it never tucks back in under the seat or between the legs.
    const belt = Math.round((beltY - hemY) / SLICE);
    for (let s = Math.min(belt, slices - 1) - 1; s >= 0; s--) column[s] = Math.max(column[s], column[s + 1]);
    radii.forEach((r, s) => { r[k] = column[s]; });
  }
  const radiusAt = (k, y) => {
    const f = THREE.MathUtils.clamp((y - hemY) / SLICE, 0, slices - 1);
    const s0 = Math.floor(f), s1 = Math.min(slices - 1, s0 + 1), t = f - s0;
    return THREE.MathUtils.lerp(radii[s0][k], radii[s1][k], t);
  };
  const centreAt = (y) => {
    const f = THREE.MathUtils.clamp((y - hemY) / SLICE, 0, slices - 1);
    const s0 = Math.floor(f), s1 = Math.min(slices - 1, s0 + 1), t = f - s0;
    return [THREE.MathUtils.lerp(centres[s0][0], centres[s1][0], t), THREE.MathUtils.lerp(centres[s0][1], centres[s1][1], t)];
  };

  const ROWS = Math.ceil((topY - hemY) / 0.012);
  const positions = [], uvs = [], indices = [], zones = [];
  for (let j = 0; j <= ROWS; j++) {
    for (let k = 0; k <= AROUND; k++) {
      const kk = k % AROUND;
      const theta = -Math.PI + (2 * Math.PI * k) / AROUND;
      const top = neckline(theta);
      const y = hemY + (j / ROWS) * (top - hemY);
      const [cx, cz] = centreAt(y);
      let r = radiusAt(kk, y);
      // Satin folds hang from the belt, deepening towards the hem; the collar and belt stand proud of the satin.
      const skirt = smooth(beltY - 0.04, hemY, y);
      r *= 1 + 0.035 * skirt * Math.sin(7 * theta + 0.6) + 0.02 * skirt * Math.sin(13 * theta + 1.9);
      // Room at the front for the knees, which come forward under the skirt when the hips dip.
      r += 0.07 * smooth(hips.y - 0.12, hemY, y) * Math.max(0, Math.cos(theta));
      r += 0.012 * smooth(top - TRIM - 0.01, top - TRIM * 0.4, y);
      r += 0.008 * (1 - smooth(0.018, 0.026, Math.abs(y - beltY)));
      positions.push(cx + r * Math.sin(theta), y, cz + r * Math.cos(theta));
      uvs.push(k / AROUND, j / ROWS);
      zones.push(y);
    }
  }
  const stride = AROUND + 1;
  for (let j = 0; j < ROWS; j++) for (let k = 0; k < AROUND; k++) {
    const a = j * stride + k, b = a + 1, c = a + stride, d = c + 1;
    indices.push(a, b, d, a, d, c);
  }
  const bodyVertices = positions.length / 3;

  /* ---- sleeves */
  const SLEEVE_AROUND = 32;
  const sleeveTop = [];
  for (const side of ["Left", "Right"]) {
    const shoulder = at(`${side}Arm`), elbow = at(`${side}ForeArm`), wrist = at(`${side}Hand`);
    const cuff = elbow.clone().lerp(wrist, 0.6);
    const path = new THREE.CatmullRomCurve3([shoulder, elbow, cuff], false, "centripetal");
    const length = path.getLength();
    const arm = index.members(new RegExp(`^${side}(Arm|ForeArm)$`));
    const steps = Math.ceil(length / 0.015);
    const frames = path.computeFrenetFrames(steps, false);
    // Keep each ring's seam facing the same way (towards the back) so the tube does not twist.
    const ringRadii = [], ringFrames = [];
    for (let i = 0; i <= steps; i++) {
      const u = i / steps, p = path.getPointAt(u), tangent = frames.tangents[i];
      const normal = new THREE.Vector3(0, 0, -1).projectOnPlane(tangent).normalize();
      const binormal = new THREE.Vector3().crossVectors(tangent, normal);
      let r = 0.04;
      for (const v of arm) {
        const dx = world[v * 3] - p.x, dy = world[v * 3 + 1] - p.y, dz = world[v * 3 + 2] - p.z;
        const along = dx * tangent.x + dy * tangent.y + dz * tangent.z;
        if (Math.abs(along) > 0.012) continue;
        r = Math.max(r, Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - along * along)));
      }
      ringRadii.push(r);
      ringFrames.push({ p, tangent, normal, binormal, u });
    }
    blur(ringRadii, 6, false);
    // A loose sleeve: ease all along, widening towards the cuff.
    ringRadii.forEach((r, i) => { ringRadii[i] = r + EASE + 0.018 * smooth(0.35, 1, i / steps); });
    // Shoulder cap: a dome over the end of the tube, rising into the robe's shoulder.
    const cap = 6, start = positions.length / 3;
    const rings = [];
    for (let c = cap; c >= 1; c--) {
      const phi = (c / cap) * (Math.PI / 2) * 0.92, f = ringFrames[0];
      rings.push({ p: f.p.clone().addScaledVector(f.tangent, -0.55 * ringRadii[0] * Math.sin(phi)), f, r: ringRadii[0] * Math.cos(phi), v: 0 });
    }
    ringFrames.forEach((f, i) => rings.push({ p: f.p, f, r: ringRadii[i], v: f.u }));
    rings.forEach((ring, i) => {
      for (let k = 0; k <= SLEEVE_AROUND; k++) {
        const a = (2 * Math.PI * k) / SLEEVE_AROUND;
        const q = ring.p.clone().addScaledVector(ring.f.normal, ring.r * Math.cos(a)).addScaledVector(ring.f.binormal, ring.r * Math.sin(a));
        positions.push(q.x, q.y, q.z);
        // Sleeves use the top strip of the texture: u around, v along the arm (the cuff band is trim).
        uvs.push(k / SLEEVE_AROUND, 1 + ring.v);
        zones.push(-1);
      }
    });
    const ringStride = SLEEVE_AROUND + 1;
    for (let i = 0; i < rings.length - 1; i++) for (let k = 0; k < SLEEVE_AROUND; k++) {
      const a = start + i * ringStride + k, b = a + 1, c = a + ringStride, d = c + 1;
      indices.push(a, d, b, a, c, d);
    }
    sleeveTop.push({ side, start, end: positions.length / 3, length });
  }

  /* ---- skinning: borrow the nearest body vertices' influences, then fold the result back into the bind pose */
  const torsoGrid = index.grid(torso);
  const armGrids = Object.fromEntries(["Left", "Right"].map((side) =>
    [side, index.grid(index.members(new RegExp(`^(${side}(Shoulder|Arm|ForeArm)|Spine)$`)))]));
  const hipsIndex = body.skeleton.bones.indexOf(bone("Hips"));
  const count = positions.length / 3;
  const skinIndex = new Uint16Array(count * 4), skinWeight = new Float32Array(count * 4);
  const p = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    p.fromArray(positions, i * 3);
    const sleeve = sleeveTop.find((s) => i >= s.start && i < s.end);
    const influence = index.weightsNear(sleeve ? armGrids[sleeve.side] : torsoGrid, p);
    if (!sleeve) {
      // The skirt hangs from the pelvis: below the hip joints it mostly follows the hips, not one thigh, so it never
      // splits, but keeps a little of the thighs so the front gives way to the knees.
      const k = 0.7 * smooth(hips.y - 0.02, hips.y - 0.16, zones[i]);
      const total = [...influence.values()].reduce((a, b) => a + b, 0) || 1;
      for (const [joint, w] of influence) influence.set(joint, (w / total) * (1 - k));
      influence.set(hipsIndex, (influence.get(hipsIndex) || 0) + k);
    }
    const top = [...influence].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const total = top.reduce((sum, [, w]) => sum + w, 0) || 1;
    top.forEach(([joint, w], k) => { skinIndex[i * 4 + k] = joint; skinWeight[i * 4 + k] = w / total; });
  }
  // World (as posed now) → bind space: undo the blended bone transforms of each vertex. three skins a vertex as
  // world = matrixWorld · bindMatrixInverse · blend · bindMatrix · bind, where an attached mesh's bindMatrixInverse is
  // its own matrixWorld inverse.
  const unbind = body.bindMatrix.clone().invert();
  const toSkinned = body.bindMode === THREE.AttachedBindMode
    ? new THREE.Matrix4()
    : body.bindMatrixInverse.clone().invert().multiply(body.matrixWorld.clone().invert());
  const boneMatrices = body.skeleton.bones.map((b, i) => new THREE.Matrix4().multiplyMatrices(b.matrixWorld, body.skeleton.boneInverses[i]));
  const blend = new THREE.Matrix4(), part = new THREE.Matrix4();
  for (let i = 0; i < count; i++) {
    blend.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    for (let k = 0; k < 4; k++) {
      const w = skinWeight[i * 4 + k];
      if (!w) continue;
      part.copy(boneMatrices[skinIndex[i * 4 + k]]);
      for (let e = 0; e < 16; e++) blend.elements[e] += part.elements[e] * w;
    }
    p.fromArray(positions, i * 3).applyMatrix4(toSkinned).applyMatrix4(blend.invert()).applyMatrix4(unbind);
    p.toArray(positions, i * 3);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeight, 4));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  /* ---- satin and trim: the texture's lower half is the body (u around from the back seam, v hem → collar), the
     upper half the sleeves (v shoulder → cuff) */
  // Offline tools and tests (no DOM) get the geometry without the satin texture.
  const map = typeof document === "undefined" ? null : canvasTexture(2048, 2048, (g, W, H) => {
    const half = H / 2;
    g.fillStyle = color;
    g.fillRect(0, 0, W, H);
    // Subtle satin weave so the black reads as fabric in close-ups.
    g.globalAlpha = 0.05;
    for (let y = 0; y < H; y += 3) { g.fillStyle = y % 6 ? "#ffffff" : "#000000"; g.fillRect(0, y, W, 1); }
    g.globalAlpha = 1;
    g.fillStyle = trim;
    const px = (u, v) => [u * W, H - v * half]; // body: v ∈ [0, 1] → bottom half
    const band = (vOf) => {
      g.beginPath();
      for (let k = 0; k <= AROUND; k++) g.lineTo(...px(k / AROUND, vOf(k, 0)));
      for (let k = AROUND; k >= 0; k--) g.lineTo(...px(k / AROUND, vOf(k, 1)));
      g.closePath(); g.fill();
    };
    const theta = (k) => -Math.PI + (2 * Math.PI * k) / AROUND;
    const vAt = (k, y) => (y - hemY) / (neckline(theta(k)) - hemY);
    band((k, edge) => edge ? 0 : vAt(k, hemY + TRIM));                                  // hem
    band((k, edge) => edge ? 1 : vAt(k, neckline(theta(k)) - TRIM));                     // shawl collar
    band((k, edge) => vAt(k, beltY + (edge ? 0.022 : -0.022)));                          // belt
    // The wrap's front edge runs from the V down to the hem, crossing to the wearer's left at the belt.
    g.beginPath();
    const edgeAt = (y) => 0.34 * smooth(vBottom + 0.01, beltY - 0.02, y) + 0.03;
    const steps = 40, left = [], right = [];
    for (let i = 0; i <= steps; i++) {
      const y = THREE.MathUtils.lerp(vBottom - 0.02, hemY, i / steps);
      const r = radiusAt(AROUND / 2, y), half = (TRIM / 2) / r;
      for (const [list, dt] of [[left, -half], [right, half]]) {
        const t = edgeAt(y) + dt, k = ((t + Math.PI) / (2 * Math.PI)) * AROUND;
        list.push(px(k / AROUND, (y - hemY) / (neckline(t) - hemY)));
      }
    }
    for (const q of left) g.lineTo(...q);
    for (const q of right.reverse()) g.lineTo(...q);
    g.closePath(); g.fill();
    // Sleeves: cuff band at the end of each sleeve.
    const cuff = TRIM / Math.max(...sleeveTop.map((s) => s.length));
    g.fillRect(0, 0, W, cuff * half);
  }, anisotropy);
  // Sleeve v runs 1 → 2; map it onto the texture's top half.
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    const v = uv.getY(i);
    uv.setY(i, v <= 1 ? v * 0.5 : 0.5 + (v - 1) * 0.5);
  }
  const material = new THREE.MeshPhysicalMaterial({
    map, roughness: 0.42, metalness: 0, sheen: 0.8, sheenRoughness: 0.4, sheenColor: new THREE.Color(0x6a6a72),
    side: THREE.DoubleSide
  });
  const robe = new THREE.SkinnedMesh(geometry, material);
  robe.name = "robe";
  robe.position.copy(body.position);
  robe.quaternion.copy(body.quaternion);
  robe.scale.copy(body.scale);
  robe.bindMode = body.bindMode;
  robe.bind(body.skeleton, body.bindMatrix);
  robe.frustumCulled = false;
  robe.castShadow = robe.receiveShadow = true;
  body.parent.add(robe);
  robe.updateMatrixWorld(true); // an attached mesh's bind-matrix inverse follows its world matrix
  return robe;
}
