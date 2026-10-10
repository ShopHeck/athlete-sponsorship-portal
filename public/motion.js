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
    // Blend the corners' influences as the surface itself interpolates them, keeping the four strongest.
    const influence = new Map();
    for (let c = 0; c < 3; c++) for (let k = 0; k < 4; k++) {
      const w = srcWeight.getComponent(ids[c], k) * bary.getComponent(c);
      if (w <= 0) continue;
      const joint = srcIndex.array[ids[c] * srcIndex.itemSize + k]; // joint indices are never normalized
      influence.set(joint, (influence.get(joint) || 0) + w);
    }
    const top = [...influence].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const total = top.reduce((sum, [, w]) => sum + w, 0) || 1;
    top.forEach(([joint, w], k) => { skinIndex[i * 4 + k] = joint; skinWeight[i * 4 + k] = w / total; });
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
const CROSSFADE = 0.45, SETTLE = 0.7, MIN_PLAY_SECONDS = 2.8;
const GUARD_ENTER = 0.6, GUARD_EXIT = 0.15, GUARD_HOLD = 0.18;
const YAW_ALLOWANCE = THREE.MathUtils.degToRad(28);

// Library moves step and lunge around the ring (some even start off-centre) and turn the athlete away from the
// camera, some by a quarter turn. Pin the root's horizontal position to its bind pose and centre the hips' yaw on
// the bind facing (a soft allowance keeps the natural sway), so the athlete performs in place, facing the sponsor.
// Vertical bob and crouch are kept.
function anchoredClip(root, clip) {
  const out = clip.clone();
  const hips = torsoChain(root)[0];
  for (const track of out.tracks) {
    const { nodeName } = THREE.PropertyBinding.parseTrackName(track.name);
    if (track.name.endsWith(".quaternion") && nodeName === hips?.name) { centreYaw(track, hips); continue; }
    if (!track.name.endsWith(".position") || track.times.length < 2) continue;
    const bone = root.getObjectByName(nodeName);
    if (!bone) continue;
    const { values } = track;
    for (let i = 0; i < values.length; i += 3) {
      values[i] = bone.position.x;
      values[i + 2] = bone.position.z;
    }
  }
  return out;
}

const yawOf = (q, f = new THREE.Vector3()) => { f.set(0, 0, 1).applyQuaternion(q); return Math.atan2(f.x, f.z); };
function centreYaw(track, hips) {
  const { values } = track;
  const q = new THREE.Quaternion(), turn = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const yaws = [];
  let sin = 0, cos = 0;
  for (let i = 0; i < values.length; i += 4) {
    const yaw = yawOf(q.fromArray(values, i));
    yaws.push(yaw); sin += Math.sin(yaw); cos += Math.cos(yaw);
  }
  const mean = Math.atan2(sin, cos), bind = yawOf(hips.quaternion);
  for (let k = 0; k < yaws.length; k++) {
    let d = yaws[k] - mean; d = Math.atan2(Math.sin(d), Math.cos(d));
    const target = bind + YAW_ALLOWANCE * Math.tanh(d / YAW_ALLOWANCE);
    q.fromArray(values, k * 4).premultiply(turn.setFromAxisAngle(up, target - yaws[k])).toArray(values, k * 4);
  }
}

// One-frame clip holding the stance for every animated property, so moves can blend back to it: the first frame
// of the tenant's rest clip (A-posed rigs look stiff in their bind pose), else the bind pose.
function restClip(root, clips, stance) {
  const tracks = [];
  const seen = new Set();
  const hips = torsoChain(root)[0];
  for (const track of stance?.tracks || []) {
    if (!track.times.length) continue;
    const values = Array.from(track.values.slice(0, track.getValueSize()));
    if (track.name.endsWith(".position")) {
      // Only the hips travel in Meshy's clips: keep the stance's height (moves blend from it), pinned in place.
      if (THREE.PropertyBinding.parseTrackName(track.name).nodeName !== hips?.name) continue;
      values[0] = hips.position.x;
      values[2] = hips.position.z;
    }
    seen.add(track.name);
    tracks.push(new track.constructor(track.name, [0], values));
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

/* -------------------------------------------------- authored moves */
// Moves the library doesn't have are keyframed here on the stance pose. Rotations are given about axes of the
// stance's world frame (+X right, +Y up, +Z towards the sponsor) and ride along with the parent bone, so an elbow
// flexes about the elbow wherever the upper arm went.
const X = new THREE.Vector3(1, 0, 0);
function turned(bone, rotations) {
  const parent = bone.parent.getWorldQuaternion(new THREE.Quaternion());
  const q = parent.clone().multiply(bone.quaternion);
  for (const [axis, deg] of rotations) q.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(deg)));
  return parent.invert().multiply(q);
}
const ease = (t, start, end) => {
  const x = THREE.MathUtils.clamp((t - start) / (end - start), 0, 1);
  return x * x * (3 - 2 * x);
};

function bendArm(arm, forearm, hand, target, pole, amount) {
  const shoulder = arm.getWorldPosition(new THREE.Vector3());
  const elbow = forearm.getWorldPosition(new THREE.Vector3());
  const wrist = hand.getWorldPosition(new THREE.Vector3());
  const upperLength = shoulder.distanceTo(elbow), lowerLength = elbow.distanceTo(wrist);
  const direction = target.clone().sub(shoulder);
  const distance = direction.length();
  if (distance < 1e-6) return;
  direction.divideScalar(distance);
  const reach = THREE.MathUtils.clamp(distance, Math.abs(upperLength - lowerLength) + 1e-5, upperLength + lowerLength - 1e-5);
  const along = (upperLength ** 2 - lowerLength ** 2 + reach ** 2) / (2 * reach);
  const outward = pole.clone().projectOnPlane(direction).normalize();
  const desiredElbow = shoulder.clone().addScaledVector(direction, along)
    .addScaledVector(outward, Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2)));
  const baseArm = arm.quaternion.clone(), baseForearm = forearm.quaternion.clone();

  const pointBone = (bone, from, to) => {
    const parent = bone.parent.getWorldQuaternion(new THREE.Quaternion());
    const swing = new THREE.Quaternion().setFromUnitVectors(from.normalize(), to.normalize());
    bone.quaternion.premultiply(parent.clone().invert().multiply(swing).multiply(parent));
  };
  pointBone(arm, elbow.sub(shoulder), desiredElbow.sub(shoulder));
  arm.updateMatrixWorld(true);
  const rotatedElbow = forearm.getWorldPosition(new THREE.Vector3());
  const rotatedWrist = hand.getWorldPosition(new THREE.Vector3());
  pointBone(forearm, rotatedWrist.sub(rotatedElbow), target.clone().sub(rotatedElbow));
  const finalArm = arm.quaternion.clone(), finalForearm = forearm.quaternion.clone();
  arm.quaternion.copy(baseArm).slerp(finalArm, amount);
  forearm.quaternion.copy(baseForearm).slerp(finalForearm, amount);
  arm.updateMatrixWorld(true);
}

function between(t, stops) {
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [start, before] = stops[i - 1], [end, after] = stops[i];
      return THREE.MathUtils.lerp(before, after, ease(t, start, end));
    }
  }
  return stops.at(-1)[1];
}

function victoryChestBeat(root) {
  const bone = (name) => root.getObjectByName(name);
  const head = bone("Head"), spine = bone("Spine");
  const rArm = bone("RightArm"), rFore = bone("RightForeArm"), rHand = bone("RightHand");
  const lArm = bone("LeftArm"), lFore = bone("LeftForeArm"), lHand = bone("LeftHand");
  const bones = [head, spine, rArm, rFore, lArm, lFore];
  if (![...bones, rHand, lHand].every(Boolean)) return null;
  const initial = bones.map((b) => b.quaternion.clone());
  const values = bones.map(() => []);
  const times = [];
  const beats = [[0, 0], [1.4, 0], [1.6, 1], [1.82, 0], [2.05, 1], [2.27, 0], [2.5, 1], [2.9, 1], [3.2, 0]];
  for (let frame = 0; frame <= 120; frame++) {
    const t = frame / 30;
    bones.forEach((b, i) => b.quaternion.copy(initial[i]));
    root.updateMatrixWorld(true);
    const bow = ease(t, 0, 0.5) * (1 - ease(t, 1, 1.55));
    const raised = ease(t, 1, 1.55) * (1 - ease(t, 3, 3.7));
    spine.quaternion.copy(turned(spine, [[X, 7 * bow - 5 * raised]]));
    spine.updateMatrixWorld(true);
    head.quaternion.copy(turned(head, [[X, 32 * bow - 24 * raised]]));
    head.updateMatrixWorld(true);

    if (raised > 0) {
      const shoulder = rArm.getWorldPosition(new THREE.Vector3());
      const target = shoulder.clone().add(new THREE.Vector3(-0.015, 0.43, 0.16));
      bendArm(rArm, rFore, rHand, target, new THREE.Vector3(-0.3, 0.15, 0.13), raised);
    }
    const left = ease(t, 1, 1.4) * (1 - ease(t, 3.1, 3.7));
    if (left > 0) {
      const shoulder = lArm.getWorldPosition(new THREE.Vector3());
      const beat = between(t, beats);
      const target = shoulder.clone().add(new THREE.Vector3(-0.14, -0.18 + 0.045 * (1 - beat), 0.11 + 0.10 * (1 - beat)));
      bendArm(lArm, lFore, lHand, target, new THREE.Vector3(0.09, -0.3, 0.1), left);
    }
    times.push(t);
    bones.forEach((b, i) => b.quaternion.toArray(values[i], values[i].length));
  }
  bones.forEach((b, i) => b.quaternion.copy(initial[i]));
  root.updateMatrixWorld(true);
  return new THREE.AnimationClip("Victory_Chest_Beat", 4,
    bones.map((b, i) => new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, values[i])));
}

function authoredClips(root) {
  return [victoryChestBeat(root)].filter(Boolean);
}

/* ---------------------------------------------------- power stance */
// A fighter's square-on power stance built from the bind pose of any Meshy rig: feet planted wider than the
// shoulders with the toes turned out, knees softly bent, chest up, chin tucked and the arms hanging by the sides
// with the palms turned to the thighs. Directions come from the body itself (toes are forward, the left hip is
// left), so it works whatever way the model faces and at any scale. Each option scales the default.
export const POWER_STANCE = "Power_Stance";
export const POWER_STANCE_DEFAULTS = Object.freeze({
  stanceWidth: 1.3,     // ankle spacing ÷ shoulder-joint spacing
  toeOutDegrees: 12,    // each foot turned out from straight ahead
  kneeBend: 0.035,      // hips lowered by this fraction of the standing hip height
  chestDegrees: 4,      // upper spine lifted back
  chinDegrees: 6,       // head tipped down, eyes level with the sponsor
  handDrop: 0.94,       // hand below the shoulder, as a fraction of the arm's length
  handOut: 0.2,         // hand outside the shoulder, clearing the thigh
  handForward: 0.04,    // hand slightly in front of the thigh
  palmTurnDegrees: 80   // forearm roll that turns Meshy's forward-facing palms to the thighs (thumbs forward)
});
const STANCE_BONES = ["Hips", "Head", ...["Left", "Right"].flatMap((side) =>
  ["Arm", "ForeArm", "Hand", "UpLeg", "Leg", "Foot", "ToeBase"].map((joint) => side + joint))];

// Rotates `bone` (in world space) so that its child direction `from` points along `to`.
function aimBone(bone, from, to) {
  const parent = bone.parent.getWorldQuaternion(new THREE.Quaternion());
  const swing = new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(), to.clone().normalize());
  bone.quaternion.premultiply(parent.clone().invert().multiply(swing).multiply(parent));
  bone.updateMatrixWorld(true);
}

// Rotates `bone` by `degrees` about a world axis.
function spinBone(bone, axis, degrees) {
  const parent = bone.parent.getWorldQuaternion(new THREE.Quaternion());
  const turn = new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(degrees));
  bone.quaternion.premultiply(parent.clone().invert().multiply(turn).multiply(parent));
  bone.updateMatrixWorld(true);
}

// Two-bone IK: places `end` at `target` with the middle joint bent towards `pole`.
function reach(upper, lower, end, target, pole) {
  const start = upper.getWorldPosition(new THREE.Vector3());
  const middle = lower.getWorldPosition(new THREE.Vector3());
  const tip = end.getWorldPosition(new THREE.Vector3());
  const a = start.distanceTo(middle), b = middle.distanceTo(tip);
  const direction = target.clone().sub(start);
  const distance = THREE.MathUtils.clamp(direction.length(), Math.abs(a - b) + 1e-5, a + b - 1e-5);
  direction.normalize();
  const along = (a ** 2 - b ** 2 + distance ** 2) / (2 * distance);
  const bend = pole.clone().projectOnPlane(direction).normalize();
  const elbow = start.clone().addScaledVector(direction, along).addScaledVector(bend, Math.sqrt(Math.max(0, a ** 2 - along ** 2)));
  aimBone(upper, middle.sub(start), elbow.sub(start));
  const placed = lower.getWorldPosition(new THREE.Vector3());
  aimBone(lower, end.getWorldPosition(new THREE.Vector3()).sub(placed), start.addScaledVector(direction, distance).sub(placed));
}

// Returns a one-frame clip holding the power stance, or null if the rig lacks the bones. Leaves the rig as found.
export function powerStance(root, options = {}) {
  const o = { ...POWER_STANCE_DEFAULTS, ...options };
  if (Object.values(o).some((value) => !Number.isFinite(value))) throw new Error("Power stance options must be finite numbers");
  const bone = (name) => root.getObjectByName(name);
  if (!STANCE_BONES.every((name) => bone(name)?.isBone)) return null;
  const bones = [];
  root.traverse((node) => { if (node.isBone) bones.push(node); });
  const saved = bones.map((node) => [node, node.quaternion.clone(), node.position.clone()]);
  root.updateMatrixWorld(true);
  const at = (name) => bone(name).getWorldPosition(new THREE.Vector3());
  const up = new THREE.Vector3(0, 1, 0);
  const flat = (v) => v.projectOnPlane(up).normalize();
  const left = flat(at("LeftUpLeg").sub(at("RightUpLeg")));
  const forward = flat(at("LeftToeBase").sub(at("LeftFoot")).add(at("RightToeBase").sub(at("RightFoot"))));
  const across = new THREE.Vector3().crossVectors(up, forward).normalize(); // points to the athlete's left
  if (across.dot(left) < 0.5) return null; // toes and hips disagree: not a standing humanoid
  const ankles = { Left: at("LeftFoot"), Right: at("RightFoot") };
  const feet = Object.fromEntries(["Left", "Right"].map((side) => [side, bone(`${side}Foot`).getWorldQuaternion(new THREE.Quaternion())]));
  const hipsBone = bone("Hips"), hips = at("Hips");
  const shoulders = at("LeftArm").distanceTo(at("RightArm"));
  const legLength = hips.y - (ankles.Left.y + ankles.Right.y) / 2;

  const lowered = hips.clone().addScaledVector(up, -o.kneeBend * legLength);
  hipsBone.position.copy(hipsBone.parent.worldToLocal(lowered));
  root.updateMatrixWorld(true);
  const centre = ankles.Left.clone().add(ankles.Right).multiplyScalar(0.5);
  for (const [side, sign] of [["Left", 1], ["Right", -1]]) {
    const target = centre.clone().addScaledVector(across, sign * o.stanceWidth * shoulders / 2);
    target.y = ankles[side].y; // square: both ankles level with the bind pose's midpoint, front to back
    reach(bone(`${side}UpLeg`), bone(`${side}Leg`), bone(`${side}Foot`), target,
      forward.clone().addScaledVector(across, sign * 0.35));
    const foot = bone(`${side}Foot`);
    const turned = new THREE.Quaternion().setFromAxisAngle(up, THREE.MathUtils.degToRad(sign * o.toeOutDegrees)).multiply(feet[side]);
    foot.quaternion.copy(foot.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(turned));
    foot.updateMatrixWorld(true);
  }

  const chest = bone("Spine02") || bone("Spine01") || bone("Spine");
  if (chest) spinBone(chest, across, -o.chestDegrees);
  spinBone(bone("Head"), across, o.chinDegrees + o.chestDegrees);
  for (const [side, sign] of [["Left", 1], ["Right", -1]]) {
    const arm = bone(`${side}Arm`), forearm = bone(`${side}ForeArm`), hand = bone(`${side}Hand`);
    const shoulder = at(`${side}Arm`);
    const length = shoulder.distanceTo(at(`${side}ForeArm`)) + at(`${side}ForeArm`).distanceTo(at(`${side}Hand`));
    const target = shoulder.clone().addScaledVector(up, -o.handDrop * length)
      .addScaledVector(across, sign * o.handOut * length).addScaledVector(forward, o.handForward * length);
    reach(arm, forearm, hand, target, forward.clone().negate().addScaledVector(across, sign * 0.5));
    // A single hand bone carries no palm direction, so the roll is a per-rig option (positive turns thumbs forward).
    if (o.palmTurnDegrees) spinBone(forearm, at(`${side}Hand`).sub(at(`${side}ForeArm`)).normalize(), sign * o.palmTurnDegrees);
  }

  const tracks = bones.map((node) => new THREE.QuaternionKeyframeTrack(`${node.name}.quaternion`, [0], node.quaternion.normalize().toArray()));
  tracks.push(new THREE.VectorKeyframeTrack(`${hipsBone.name}.position`, [0], hipsBone.position.toArray()));
  for (const [node, quaternion, position] of saved) { node.quaternion.copy(quaternion); node.position.copy(position); }
  root.updateMatrixWorld(true);
  return new THREE.AnimationClip(POWER_STANCE, 0, tracks);
}

// Puts the rig into a clip's first frame (used so authored moves start from the stance, not the bind pose).
function poseFromFrame(root, clip) {
  for (const track of clip.tracks) {
    const { nodeName, propertyName } = THREE.PropertyBinding.parseTrackName(track.name);
    const node = THREE.PropertyBinding.findNode(root, nodeName);
    node?.[propertyName]?.fromArray?.(track.values, 0);
  }
  root.updateMatrixWorld(true);
}

// Plays the tenant's curated moves on demand; the athlete otherwise holds the rest stance.
export function createMotion(root, gltfClips, entries, { onChange, onSettled, rest: restName, stance: stanceOptions } = {}) {
  const byName = new Map(gltfClips.map((clip) => [clip.name, clip]));
  if (restName === POWER_STANCE && !byName.has(POWER_STANCE)) {
    const clip = powerStance(root, stanceOptions);
    if (clip) byName.set(POWER_STANCE, clip);
  }
  const torso = torsoChain(root).map((bone) => [bone, bone.quaternion.clone()]);
  const stance = byName.has(restName) ? anchoredClip(root, byName.get(restName)) : null;
  if (stance) poseFromFrame(root, stance);
  for (const clip of authoredClips(root)) byName.set(clip.name, clip);
  const moves = new Map(entries.filter((e) => byName.has(e.clip)).map((e) => [e.clip, { ...e, clip: anchoredClip(root, byName.get(e.clip)) }]));
  if (!moves.size) return null;
  const mixer = new THREE.AnimationMixer(root);
  const rest = mixer.clipAction(restClip(root, [...moves.values()].map((m) => m.clip), stance));
  const jab = moves.get("Left_Jab_from_Guard");
  const guard = jab && mixer.clipAction(restClip(root, [jab.clip], jab.clip));
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
  mixer.addEventListener("finished", (e) => {
    if (e.action !== current?.action) return;
    if (current.phase === "strike") {
      const from = current.action;
      guard.reset().play();
      guard.crossFadeFrom(from, GUARD_EXIT, false);
      current.action = guard;
      current.phase = "recover";
      current.elapsed = 0;
    } else settle();
  });

  function play(name) {
    const move = moves.get(name);
    if (!move) return;
    const prev = current ? current.action : rest;
    if (current?.name === name) return;
    if (move === jab) {
      guard.reset().play();
      guard.crossFadeFrom(prev, GUARD_ENTER, false);
      current = { name, action: guard, phase: "enter", elapsed: 0 };
      settling = 0;
      onChange?.(name);
      return;
    }
    const action = mixer.clipAction(move.clip);
    const reps = Math.max(1, Math.round(MIN_PLAY_SECONDS / move.clip.duration));
    action.reset().setLoop(THREE.LoopRepeat, reps).play();
    action.clampWhenFinished = true;
    action.crossFadeFrom(prev, name === "Victory_Chest_Beat" ? 0.3 : CROSSFADE, false);
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
      const posed = torso.map(([bone]) => bone.quaternion.clone());
      for (const [bone, q] of torso) bone.quaternion.copy(q);
      root.updateMatrixWorld(true);
      // A zero-length mixer step does not rewrite unchanged bindings, so put the stance's torso back by hand.
      try { return fn(); } finally { torso.forEach(([bone], i) => bone.quaternion.copy(posed[i])); root.updateMatrixWorld(true); }
    },
    get playing() { return current?.name || null; },
    // Advances the pose; returns true while the body is moving and the frame must be redrawn.
    update(dt) {
      if (!current && settling <= -0.1) return false; // one extra step lands exactly on the rest pose
      mixer.update(dt);
      if (current?.phase === "enter" || current?.phase === "recover") {
        current.elapsed += dt;
        if (current.phase === "enter" && current.elapsed >= GUARD_ENTER) {
          const action = mixer.clipAction(jab.clip);
          action.reset().setLoop(THREE.LoopOnce, 1).play();
          action.clampWhenFinished = true;
          action.crossFadeFrom(guard, 0.1, false);
          current.action = action;
          current.phase = "strike";
        } else if (current.phase === "recover" && current.elapsed >= GUARD_EXIT + GUARD_HOLD) {
          settle();
        }
      }
      if (!current) {
        const wasSettling = settling > 0;
        settling -= dt;
        if (wasSettling && settling <= 0) onSettled?.();
      }
      return true;
    }
  };
}
