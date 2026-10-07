import * as THREE from "three";

/* ------------------------------------------------ skinned sponsor decals */
// Nearest-vertex lookup over a skinned mesh's rest-pose positions (uniform hash grid).
// Spatial hash of a geometry's triangles: finds the body triangle a decal vertex was clipped from, so artwork maps
// to that exact surface rather than a nearby one (e.g. a braid resting on the chest).
function triangleGrid(geometry) {
  const pos = geometry.attributes.position, index = geometry.index;
  const vert = index ? (t, k) => index.getX(t * 3 + k) : (t, k) => t * 3 + k;
  const count = (index ? index.count : pos.count) / 3;
  geometry.computeBoundingBox();
  const size = geometry.boundingBox.getSize(new THREE.Vector3());
  const cell = Math.max(size.x, size.y, size.z) / 160 || 1;
  const key = (x, y, z) => `${x},${y},${z}`;
  const cells = new Map(), box = new THREE.Box3(), v = new THREE.Vector3();
  for (let t = 0; t < count; t++) {
    box.makeEmpty();
    for (let k = 0; k < 3; k++) box.expandByPoint(v.fromBufferAttribute(pos, vert(t, k)));
    const x0 = Math.floor(box.min.x / cell), y0 = Math.floor(box.min.y / cell), z0 = Math.floor(box.min.z / cell);
    const x1 = Math.floor(box.max.x / cell), y1 = Math.floor(box.max.y / cell), z1 = Math.floor(box.max.z / cell);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const k = key(x, y, z);
      let list = cells.get(k);
      if (!list) cells.set(k, (list = []));
      list.push(t);
    }
  }
  const tri = new THREE.Triangle(), closest = new THREE.Vector3(), best = new THREE.Vector3();
  return function locate(p, outBary) {
    const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell), cz = Math.floor(p.z / cell);
    let found = -1, bestD = Infinity;
    for (let r = 1; r <= 4 && found < 0; r *= 2) {
      for (let x = cx - r; x <= cx + r; x++) for (let y = cy - r; y <= cy + r; y++) for (let z = cz - r; z <= cz + r; z++) {
        for (const t of cells.get(key(x, y, z)) || []) {
          tri.setFromAttributeAndIndices(pos, vert(t, 0), vert(t, 1), vert(t, 2)).closestPointToPoint(p, closest);
          const d = closest.distanceToSquared(p);
          if (d < bestD) { bestD = d; found = t; best.copy(closest); }
        }
      }
    }
    if (found < 0) return null;
    const ids = [vert(found, 0), vert(found, 1), vert(found, 2)];
    tri.setFromAttributeAndIndices(pos, ...ids);
    if (!tri.getBarycoord(best, outBary)) outBary.set(1, 0, 0);
    return ids;
  };
}

const posed = new WeakMap();
// The body as currently posed (the rest stance), in its local space. Placements are projected onto this so they
// land where visitors see the garment, not on the arms-out bind pose the rig was built from.
export function posedGeometry(body) {
  let geo = posed.get(body);
  if (geo) return geo;
  body.updateMatrixWorld(true);
  body.skeleton.update();
  const n = body.geometry.attributes.position.count, out = new Float32Array(n * 3), v = new THREE.Vector3();
  for (let i = 0; i < n; i++) body.getVertexPosition(i, v).toArray(out, i * 3);
  geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(out, 3));
  if (body.geometry.index) geo.setIndex(body.geometry.index);
  geo.computeVertexNormals();
  posed.set(body, geo);
  return geo;
}

const grids = new WeakMap();
// DecalGeometry is built in world space on the posed body; map each vertex onto the same point of its body triangle
// in bind space and borrow that triangle's skin weights, so the artwork deforms with the athlete.
export function skinDecal(decal, body) {
  let locate = grids.get(body);
  if (!locate) grids.set(body, (locate = triangleGrid(posedGeometry(body))));
  decal.updateMatrixWorld(true);
  body.updateMatrixWorld(true);
  const geo = decal.geometry;
  geo.applyMatrix4(body.matrixWorld.clone().invert().multiply(decal.matrixWorld));
  const pos = geo.attributes.position, bind = body.geometry.attributes.position;
  const srcIndex = body.geometry.attributes.skinIndex, srcWeight = body.geometry.attributes.skinWeight;
  const skinIndex = new Uint16Array(pos.count * 4), skinWeight = new Float32Array(pos.count * 4);
  const p = new THREE.Vector3(), q = new THREE.Vector3(), bary = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const ids = locate(p.fromBufferAttribute(pos, i), bary);
    if (!ids) continue;
    p.set(0, 0, 0);
    for (let k = 0; k < 3; k++) p.addScaledVector(q.fromBufferAttribute(bind, ids[k]), bary.getComponent(k));
    pos.setXYZ(i, p.x, p.y, p.z);
    const j = ids[bary.x >= bary.y && bary.x >= bary.z ? 0 : bary.y >= bary.z ? 1 : 2];
    for (let k = 0; k < 4; k++) {
      skinIndex[i * 4 + k] = srcIndex.array[j * srcIndex.itemSize + k]; // joint indices are never normalized
      skinWeight[i * 4 + k] = srcWeight.getComponent(j, k);
    }
  }
  geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndex, 4));
  geo.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeight, 4));
  const skinned = new THREE.SkinnedMesh(geo, decal.material);
  skinned.position.copy(body.position);
  skinned.quaternion.copy(body.quaternion);
  skinned.scale.copy(body.scale);
  skinned.bindMode = body.bindMode;
  skinned.bind(body.skeleton, body.bindMatrix);
  skinned.frustumCulled = false;
  skinned.visible = decal.visible;
  skinned.renderOrder = decal.renderOrder;
  skinned.userData = decal.userData;
  body.parent.add(skinned);
  decal.removeFromParent();
  return skinned;
}

// A triangle of the decal nearest its centre, used to follow the placement (callout pin) while the body moves.
export function surfaceAnchor(mesh, worldPoint, worldNormal) {
  const pos = mesh.geometry.attributes.position;
  if (pos.count < 3) return null;
  mesh.updateMatrixWorld(true);
  mesh.skeleton.update();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let best = 0, bestD = Infinity;
  for (let i = 0; i + 2 < pos.count; i += 3) {
    mesh.getVertexPosition(i, a).add(mesh.getVertexPosition(i + 1, b)).add(mesh.getVertexPosition(i + 2, c));
    a.divideScalar(3).applyMatrix4(mesh.matrixWorld);
    const d = a.distanceToSquared(worldPoint);
    if (d < bestD) { bestD = d; best = i; }
  }
  const anchor = { mesh, tri: [best, best + 1, best + 2], sign: 1 };
  const n = new THREE.Vector3();
  readAnchor(anchor, new THREE.Vector3(), n);
  if (n.dot(worldNormal) < 0) anchor.sign = -1;
  return anchor;
}

const va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3();
export function readAnchor({ mesh, tri, sign }, outPoint, outNormal) {
  mesh.skeleton.update();
  mesh.getVertexPosition(tri[0], va).applyMatrix4(mesh.matrixWorld);
  mesh.getVertexPosition(tri[1], vb).applyMatrix4(mesh.matrixWorld);
  mesh.getVertexPosition(tri[2], vc).applyMatrix4(mesh.matrixWorld);
  outPoint.copy(va).add(vb).add(vc).divideScalar(3);
  outNormal.subVectors(vb, va).cross(vc.sub(va)).normalize().multiplyScalar(sign);
}

/* ---------------------------------------------------------- moves */
const CROSSFADE = 0.35, SETTLE = 0.5, MIN_PLAY_SECONDS = 2.8;

// Library moves step and lunge around the ring (some even start off-centre); pin the root's horizontal position to
// its bind pose so the athlete performs in place and stays framed. Vertical bob and crouch are kept.
function anchoredClip(root, clip) {
  const out = clip.clone();
  for (const track of out.tracks) {
    if (!track.name.endsWith(".position") || track.times.length < 2) continue;
    const bone = root.getObjectByName(THREE.PropertyBinding.parseTrackName(track.name).nodeName);
    if (!bone) continue;
    const { values } = track;
    for (let i = 0; i < values.length; i += 3) {
      values[i] = bone.position.x;
      values[i + 2] = bone.position.z;
    }
  }
  return out;
}

// One-frame clip holding the stance for every animated property, so moves can blend back to it: the first frame
// of the tenant's rest clip (A-posed rigs look stiff in their bind pose), else the bind pose.
function restClip(root, clips, stance) {
  const tracks = [];
  const seen = new Set();
  for (const track of stance?.tracks || []) {
    if (track.name.endsWith(".position") && track.times.length) continue;
    seen.add(track.name);
    const size = track.getValueSize();
    tracks.push(new track.constructor(track.name, [0], Array.from(track.values.slice(0, size))));
  }
  for (const clip of clips) for (const track of clip.tracks) {
    if (seen.has(track.name)) continue;
    seen.add(track.name);
    const { nodeName, propertyName } = THREE.PropertyBinding.parseTrackName(track.name);
    const node = THREE.PropertyBinding.findNode(root, nodeName);
    const value = node?.[propertyName];
    if (!value?.toArray) continue;
    const Track = propertyName === "quaternion" ? THREE.QuaternionKeyframeTrack : THREE.VectorKeyframeTrack;
    tracks.push(new Track(track.name, [0], value.toArray()));
  }
  return new THREE.AnimationClip("__rest", 0, tracks);
}

// Plays the tenant's curated moves on demand; the athlete otherwise holds the rest stance.
// Root → chest bones (the spine up to where the neck and shoulders branch off).
function torsoChain(root) {
  const chain = [];
  let bone = null;
  root.traverse((o) => { if (!bone && o.isBone) bone = o; });
  while (bone) {
    chain.push(bone);
    const kids = bone.children.filter((c) => c.isBone);
    if (chain.length > 1 && kids.length >= 3) break;
    let next = null, most = -1;
    for (const k of kids) {
      let n = 0;
      k.traverse(() => n++);
      if (n > most) { most = n; next = k; }
    }
    bone = next;
  }
  return chain;
}

export function createMotion(root, gltfClips, entries, { onChange, rest: restName } = {}) {
  const byName = new Map(gltfClips.map((clip) => [clip.name, clip]));
  const moves = new Map(entries.filter((e) => byName.has(e.clip)).map((e) => [e.clip, { ...e, clip: anchoredClip(root, byName.get(e.clip)) }]));
  if (!moves.size) return null;
  const mixer = new THREE.AnimationMixer(root);
  const rest = mixer.clipAction(restClip(root, [...moves.values()].map((m) => m.clip), byName.get(restName)));
  const torso = torsoChain(root).map((bone) => [bone, bone.quaternion.clone()]);
  rest.play();
  mixer.update(0);
  root.updateMatrixWorld(true);
  let current = null, settling = 0;

  function settle() {
    if (!current) return;
    const from = current.action;
    current = null;
    rest.reset().play();
    rest.crossFadeFrom(from, SETTLE, false);
    settling = SETTLE;
    onChange?.(null);
  }
  mixer.addEventListener("finished", (e) => { if (e.action === current?.action) settle(); });

  function play(name) {
    const move = moves.get(name);
    if (!move) return;
    const prev = current ? current.action : rest;
    const action = mixer.clipAction(move.clip);
    if (current?.action === action) return;
    const reps = Math.max(1, Math.round(MIN_PLAY_SECONDS / move.clip.duration));
    action.reset().setLoop(THREE.LoopRepeat, reps).play();
    action.clampWhenFinished = true;
    action.crossFadeFrom(prev, CROSSFADE, false);
    current = { name, action };
    settling = 0;
    onChange?.(name);
  }

  return {
    moves: [...moves.values()].map(({ clip, label }) => ({ name: clip.name, label })),
    play,
    settle,
    // Runs fn with the stance's arms and legs but the bind pose's square-on torso, so placements authored as
    // front/back/side rays land where intended even though the idle stance turns the athlete slightly.
    withProjectionPose(fn) {
      for (const [bone, q] of torso) bone.quaternion.copy(q);
      root.updateMatrixWorld(true);
      try { return fn(); } finally { mixer.update(0); root.updateMatrixWorld(true); }
    },
    get playing() { return current?.name || null; },
    // Advances the pose; returns true while the body is moving and the frame must be redrawn.
    update(dt) {
      if (!current && settling <= -0.1) return false; // one extra step lands exactly on the rest pose
      mixer.update(dt);
      if (!current) settling -= dt;
      return true;
    }
  };
}
