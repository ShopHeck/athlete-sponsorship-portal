import * as THREE from "three";

/* ---------------------------------------------------------------------------
   Placeholder sponsorship items (netlify/lib/sponsor-items.mjs). Apparel
   sleeves are positioned from the rig's arm bones; the items that are not
   printed on the athlete's own apparel are props: a cap on the head, a pair
   of gloves and a roll-up banner beside the athlete. Each anchor gives the
   centre its placements are offset from and the meshes they are projected
   onto; caps and gloves follow the Head and hand bones once attached.
--------------------------------------------------------------------------- */

const BANNER = { x: -0.82, z: -0.05, w: 0.72, h: 1.76, centerY: 0.98 };
const down = new THREE.Vector3(0, -1, 0);
const ray = new THREE.Raycaster();

const material = (color, roughness = 0.62) => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.02 });
const shade = (mesh) => { mesh.castShadow = mesh.receiveShadow = true; return mesh; };
const worldOf = (object) => object.getWorldPosition(new THREE.Vector3());
const boneNamed = (root, name) => {
  let found = null;
  root.traverse((o) => { if (!found && o.name === name) found = o; });
  return found;
};

// Upper-arm and forearm centres for sleeve placements, projected onto the athlete's own body.
export function armAnchors(root, bodyMeshes) {
  root.updateMatrixWorld(true);
  const anchors = {};
  for (const side of ["Left", "Right"]) {
    const [shoulder, elbow, wrist] = ["Arm", "ForeArm", "Hand"].map((part) => boneNamed(root, `${side}${part}`));
    const key = side.toLowerCase();
    if (shoulder && elbow) anchors[`${key}UpperArm`] = { center: worldOf(shoulder).lerp(worldOf(elbow), 0.4), meshes: bodyMeshes };
    if (elbow && wrist) anchors[`${key}Forearm`] = { center: worldOf(elbow).lerp(worldOf(wrist), 0.5), meshes: bodyMeshes };
  }
  return anchors;
}

// Distance from `center` to the body surface along a horizontal direction, measured from outside.
function reach(meshes, center, dir, fallback) {
  ray.set(center.clone().addScaledVector(dir, 1), dir.clone().negate());
  const hit = ray.intersectObjects(meshes, false)[0];
  return hit ? Math.max(0.04, 1 - hit.distance) : fallback;
}

// A cap's band and crown: the band sits a hand's width below the top of the head, and the crown's radii grow until
// the head (and any hair sticking up from it) fits inside the dome at every sampled height and direction.
function measureHead(root, meshes) {
  const head = boneNamed(root, "Head");
  const end = boneNamed(root, "head_end");
  const box = new THREE.Box3().setFromObject(root);
  const guess = end ? worldOf(end) : head ? worldOf(head).add(new THREE.Vector3(0, 0.2, 0)) : new THREE.Vector3(0, box.max.y, 0);
  ray.set(new THREE.Vector3(guess.x, box.max.y + 1, guess.z), down);
  const crown = ray.intersectObjects(meshes, false)[0]?.point.y ?? box.max.y;
  const base = new THREE.Vector3(guess.x, crown - 0.12, guess.z);
  const front = reach(meshes, base, new THREE.Vector3(0, 0, 1), 0.1);
  const back = reach(meshes, base, new THREE.Vector3(0, 0, -1), 0.1);
  base.z += (front - back) / 2;
  const height = crown - base.y + 0.015;
  let rx = (reach(meshes, base, new THREE.Vector3(1, 0, 0), 0.08) + reach(meshes, base, new THREE.Vector3(-1, 0, 0), 0.08)) / 2 + 0.012;
  let rz = (front + back) / 2 + 0.012;
  // Width and depth grow separately (a quiff only deepens the crown), and only so far: a placeholder cap may let a
  // tall hairstyle show through rather than turn into a helmet.
  const grow = { x: 1, z: 1 };
  for (const h of [0, 0.03, 0.06, 0.09]) {
    const level = base.clone().add(new THREE.Vector3(0, h, 0));
    const room = Math.sqrt(Math.max(0.05, 1 - (h / height) ** 2));
    for (let i = 0; i < 8; i++) {
      const dir = new THREE.Vector3(Math.sin(i * Math.PI / 4), 0, Math.cos(i * Math.PI / 4));
      const r = reach(meshes, level, dir, 0) + 0.008;
      const need = Math.hypot((dir.x * r) / rx, (dir.z * r) / rz) / room;
      if (Math.abs(dir.x) > 0.1) grow.x = Math.max(grow.x, need);
      if (Math.abs(dir.z) > 0.1) grow.z = Math.max(grow.z, need);
    }
  }
  rx *= Math.min(grow.x, 1.15);
  rz *= Math.min(grow.z, 1.2);
  return { bone: head, base, height, rx, rz };
}

function buildHat(root, meshes) {
  const { bone, base, height, rx, rz } = measureHead(root, meshes);
  // An animated body without a Head bone would leave the cap behind when it moves: leave its placements unplaced.
  if (!bone && meshes.some((mesh) => mesh.isSkinnedMesh)) return null;
  const fabric = material(0x23262d);
  const group = new THREE.Group();
  group.position.copy(base);
  const dome = shade(new THREE.Mesh(new THREE.SphereGeometry(1, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), fabric));
  dome.scale.set(rx, height, rz);
  // A cap's brim curves down over the eyes: tilted, it also reads from the front and side, not just edge-on.
  const brim = shade(new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.012, 32, 1, false, -Math.PI / 2, Math.PI), fabric));
  brim.position.set(0, 0.006, rz * 0.78);
  brim.rotation.x = 0.32;
  brim.scale.set(rx * 0.9, 1, 0.085);
  const button = shade(new THREE.Mesh(new THREE.SphereGeometry(0.009, 12, 8), fabric));
  button.position.y = dome.scale.y;
  group.add(dome, brim, button);
  if (bone) attachTo(bone, group);
  else root.add(group);
  return { group, anchors: { head: { center: base.clone(), meshes: [dome] } } };
}

function buildGlove(root, side, color) {
  const hand = boneNamed(root, `${side}Hand`);
  if (!hand) return null;
  const wrist = worldOf(hand);
  const child = hand.children.find((o) => o.isBone);
  const dir = child
    ? worldOf(child).sub(wrist)
    : wrist.clone().sub(worldOf(hand.parent));
  if (dir.lengthSq() < 1e-8) dir.set(0, -1, 0);
  dir.normalize();
  const along = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  const leather = material(color, 0.45);
  const group = new THREE.Group();
  const center = wrist.clone().addScaledVector(dir, 0.06);
  const fist = shade(new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), leather));
  fist.position.copy(center);
  fist.quaternion.copy(along);
  fist.scale.set(0.062, 0.08, 0.068);
  const cuff = shade(new THREE.Mesh(new THREE.CylinderGeometry(0.047, 0.05, 0.075, 24), material(0xf2f2f2, 0.7)));
  cuff.position.copy(wrist).addScaledVector(dir, -0.015);
  cuff.quaternion.copy(along);
  group.add(fist, cuff);
  attachTo(hand, group);
  return { group, center, meshes: [fist] };
}

function buildGloves(root, color) {
  const anchors = {};
  const groups = [];
  for (const side of ["Left", "Right"]) {
    const glove = buildGlove(root, side, color);
    if (!glove) continue;
    groups.push(glove.group);
    anchors[`${side.toLowerCase()}Hand`] = { center: glove.center, meshes: glove.meshes };
  }
  return { groups, anchors };
}

function buildBanner(parent) {
  const group = new THREE.Group();
  group.position.set(BANNER.x, 0, BANNER.z);
  const panel = shade(new THREE.Mesh(new THREE.BoxGeometry(BANNER.w, BANNER.h, 0.012), material(0x1c1f25, 0.8)));
  panel.position.y = BANNER.centerY;
  const metal = material(0x9aa0a8, 0.35);
  const base = shade(new THREE.Mesh(new THREE.BoxGeometry(BANNER.w + 0.06, 0.07, 0.16), metal));
  base.position.set(0, 0.035, -0.02);
  const pole = shade(new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, BANNER.centerY + BANNER.h / 2, 12), metal));
  pole.position.set(0, (BANNER.centerY + BANNER.h / 2) / 2, -0.03);
  const rail = shade(new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, BANNER.w + 0.02, 12), metal));
  rail.rotation.z = Math.PI / 2;
  rail.position.y = BANNER.centerY + BANNER.h / 2;
  group.add(panel, base, pole, rail);
  parent.add(group);
  group.updateMatrixWorld(true);
  return { group, anchors: { banner: { center: worldOf(panel), meshes: [panel] } } };
}

// Keeps the prop's current world placement while parenting it to a bone, so it follows the rig from here on.
function attachTo(bone, group) {
  group.updateMatrixWorld(true);
  bone.attach(group);
  group.updateMatrixWorld(true);
}

// Builds the props for the given item surfaces around a loaded, posed athlete. Returns each surface's top-level
// objects (to show while its tab is active) and every anchor's centre and target meshes.
export function buildItemProps(root, bodyMeshes, surfaces, { parent, gloveColor }) {
  root.updateMatrixWorld(true);
  const groups = new Map();
  const anchors = {};
  if (surfaces.has("hat")) {
    const hat = buildHat(root, bodyMeshes);
    if (hat) {
      groups.set("hat", [hat.group]);
      Object.assign(anchors, hat.anchors);
    }
  }
  if (surfaces.has("gloves")) {
    const gloves = buildGloves(root, gloveColor);
    groups.set("gloves", gloves.groups);
    Object.assign(anchors, gloves.anchors);
  }
  if (surfaces.has("banner")) {
    const banner = buildBanner(parent);
    groups.set("banner", [banner.group]);
    Object.assign(anchors, banner.anchors);
  }
  for (const list of groups.values()) for (const group of list) group.visible = false;
  return { groups, anchors };
}
