import * as THREE from "three";

/* ------------------------------------------------ skinned sponsor decals */
// Nearest-vertex lookup over a skinned mesh's rest-pose positions (uniform hash grid).
function vertexGrid(mesh) {
  const pos = mesh.geometry.attributes.position;
  mesh.geometry.computeBoundingBox();
  const size = mesh.geometry.boundingBox.getSize(new THREE.Vector3());
  const cell = Math.max(size.x, size.y, size.z) / 160 || 1;
  const key = (x, y, z) => `${x},${y},${z}`;
  const cells = new Map();
  for (let i = 0; i < pos.count; i++) {
    const k = key(Math.floor(pos.getX(i) / cell), Math.floor(pos.getY(i) / cell), Math.floor(pos.getZ(i) / cell));
    let list = cells.get(k);
    if (!list) cells.set(k, (list = []));
    list.push(i);
  }
  return function nearest(p) {
    const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell), cz = Math.floor(p.z / cell);
    let best = -1, bestD = Infinity;
    for (let r = 1; r <= 8 && best < 0; r *= 2) {
      for (let x = cx - r; x <= cx + r; x++) for (let y = cy - r; y <= cy + r; y++) for (let z = cz - r; z <= cz + r; z++) {
        const list = cells.get(key(x, y, z));
        if (!list) continue;
        for (const i of list) {
          const dx = pos.getX(i) - p.x, dy = pos.getY(i) - p.y, dz = pos.getZ(i) - p.z;
          const d = dx * dx + dy * dy + dz * dz;
          if (d < bestD) { bestD = d; best = i; }
        }
      }
    }
    return best;
  };
}

// Rest-pose geometry → world. A glTF skin ignores its mesh node's transform (Meshy rigs put a 0.01 scale there),
// so the bind-space positions are placed by the joints rather than by mesh.matrixWorld.
export function restMatrix(body) {
  body.updateMatrixWorld(true);
  const skeleton = body.skeleton;
  return new THREE.Matrix4().multiplyMatrices(skeleton.bones[0].matrixWorld, skeleton.boneInverses[0]).multiply(body.bindMatrix);
}

const grids = new WeakMap();
// DecalGeometry is built in world space from the rest pose; re-express it in the body's local space and borrow
// the skin weights of the nearest body vertex so the artwork deforms with the athlete instead of floating.
export function skinDecal(decal, body) {
  let nearest = grids.get(body);
  if (!nearest) grids.set(body, (nearest = vertexGrid(body)));
  decal.updateMatrixWorld(true);
  const geo = decal.geometry;
  geo.applyMatrix4(restMatrix(body).invert().multiply(decal.matrixWorld));
  const pos = geo.attributes.position;
  const srcIndex = body.geometry.attributes.skinIndex, srcWeight = body.geometry.attributes.skinWeight;
  const skinIndex = new Uint16Array(pos.count * 4), skinWeight = new Float32Array(pos.count * 4);
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const j = nearest(p.fromBufferAttribute(pos, i));
    if (j < 0) continue;
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
  const local = worldPoint.clone().applyMatrix4(restMatrix(mesh).invert());
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let best = 0, bestD = Infinity;
  for (let i = 0; i + 2 < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i).add(b.fromBufferAttribute(pos, i + 1)).add(c.fromBufferAttribute(pos, i + 2)).divideScalar(3);
    const d = a.distanceToSquared(local);
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
export function createMotion(root, gltfClips, entries, { onChange, rest: restName } = {}) {
  const byName = new Map(gltfClips.map((clip) => [clip.name, clip]));
  const moves = new Map(entries.filter((e) => byName.has(e.clip)).map((e) => [e.clip, { ...e, clip: anchoredClip(root, byName.get(e.clip)) }]));
  if (!moves.size) return null;
  const mixer = new THREE.AnimationMixer(root);
  const rest = mixer.clipAction(restClip(root, [...moves.values()].map((m) => m.clip), byName.get(restName)));
  rest.play();
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
