import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import { POWER_STANCE, powerStance } from "../public/motion.js";
import { validateConfig } from "../netlify/lib/validate.mjs";
import { loadPosed } from "./refit-placements.mjs";

const tenantsDir = new URL("../tenants/", import.meta.url);
const configs = [];
for (const file of (await readdir(tenantsDir)).filter((name) => name.endsWith(".json"))) {
  const config = JSON.parse(await readFile(new URL(file, tenantsDir), "utf8"));
  if (config.motion?.rest === POWER_STANCE) configs.push(config);
}

const RAYS = {
  front: (x, y) => [new THREE.Vector3(x, y, 3), new THREE.Vector3(0, 0, -1)],
  back: (x, y) => [new THREE.Vector3(x, y, -3), new THREE.Vector3(0, 0, 1)],
  left: (x, y) => [new THREE.Vector3(3, y, x), new THREE.Vector3(-1, 0, 0)],
  right: (x, y) => [new THREE.Vector3(-3, y, -x), new THREE.Vector3(1, 0, 0)]
};

// Vertices of a skinned mesh whose skin weight on the matching bones exceeds `minimum`, in world space.
function weighted(mesh, pattern, minimum) {
  mesh.skeleton.update();
  const { skinIndex, skinWeight, position } = mesh.geometry.attributes;
  const joints = mesh.skeleton.bones.flatMap((bone, i) => pattern.test(bone.name) ? [i] : []);
  const out = [];
  for (let i = 0; i < position.count; i++) {
    let weight = 0;
    for (let k = 0; k < 4; k++) if (joints.includes(skinIndex.getComponent(i, k))) weight += skinWeight.getComponent(i, k);
    if (weight > minimum) out.push(mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld));
  }
  return out;
}

test("the demo fighters all rest in the power stance", () => {
  assert.deepEqual(configs.map(({ slug }) => slug).sort(), [
    "demo-bjj-gi-men", "demo-bjj-gi-women", "demo-boxing-men", "demo-boxing-women",
    "demo-mma-women", "demo-nogi-men", "demo-nogi-women"
  ]);
});

for (const config of configs) {
  test(`${config.slug}: planted, square and wide, hands by the sides, placements unobstructed`, async () => {
    const { root, meshes, motion } = await loadPosed(
      new URL(`../public/tenants/${config.slug}/${config.model}`, import.meta.url).pathname, config, config.motion.rest);
    assert.ok(motion, "the stance must be built from the rig");
    const point = (name) => root.getObjectByName(name).getWorldPosition(new THREE.Vector3());
    const skinned = meshes.filter((mesh) => mesh.isSkinnedMesh);

    for (const side of ["Left", "Right"]) {
      const floor = Math.min(...skinned.flatMap((mesh) => weighted(mesh, new RegExp(`^${side}(Foot|ToeBase)$`), 0.8)).map((p) => p.y));
      assert.ok(Math.abs(floor) < 0.01, `${side} sole is ${floor.toFixed(3)} m off the floor`);
      const hand = point(`${side}Hand`), thigh = point(`${side}UpLeg`);
      assert.ok(hand.y < point("Hips").y, `${side} hand must hang below the hips`);
      assert.ok(Math.abs(hand.x) > Math.abs(thigh.x) + 0.08, `${side} hand must rest outside the thigh`);
    }
    const ankles = point("LeftFoot").distanceTo(point("RightFoot"));
    assert.ok(ankles > point("LeftArm").distanceTo(point("RightArm")) * 1.15, "feet must be wider than the shoulders");
    assert.ok(Math.abs(point("LeftFoot").z - point("RightFoot").z) < 0.08, "the stance is square-on");

    motion.withProjectionPose(() => {
      const hands = skinned.flatMap((mesh) => weighted(mesh, /Hand$/, 0.5));
      for (const spot of config.garments.flatMap((garment) => garment.placements)) {
        for (const side of new Set([spot.side, spot.mirror].filter(Boolean))) {
          const mirrored = side !== spot.side && ["left", "right"].includes(side) && ["left", "right"].includes(spot.side);
          const [origin, direction] = RAYS[side](mirrored ? -spot.x : spot.x, spot.y);
          const hit = new THREE.Raycaster(origin, direction).intersectObjects(meshes, false)[0];
          assert.ok(hit, `${spot.id} (${side}) must land on the body`);
          // DecalGeometry paints everything inside a w × h × 0.1 m box around the hit; no hand may be in it.
          const inside = hands.filter((p) => {
            const offset = p.clone().sub(hit.point), depth = offset.dot(direction);
            const across = offset.addScaledVector(direction, -depth);
            const horizontal = side === "front" || side === "back" ? across.x : across.z;
            return Math.abs(depth) < 0.05 && Math.abs(horizontal) < spot.w / 2 && Math.abs(across.y) < spot.h / 2;
          });
          assert.equal(inside.length, 0, `${spot.id} (${side}) would paint onto a hand`);
        }
      }
    });

    const rest = new Map();
    root.traverse((bone) => { if (bone.isBone) rest.set(bone.name, bone.quaternion.clone()); });
    for (const { name } of motion.moves) {
      motion.play(name);
      for (let i = 0; i < 60; i++) motion.update(1 / 60);
      motion.settle();
      for (let i = 0; i < 90; i++) motion.update(1 / 60);
      for (const [bone, quaternion] of rest) {
        assert.ok(root.getObjectByName(bone).quaternion.angleTo(quaternion) < 0.001, `${name} must settle back into the stance (${bone})`);
      }
    }
  });
}

test("powerStance needs a humanoid rig, rejects bad options and leaves the rig untouched", async () => {
  assert.equal(powerStance(new THREE.Group()), null);
  const config = configs.find(({ slug }) => slug === "demo-nogi-men");
  const { root } = await loadPosed(new URL(`../public/tenants/${config.slug}/${config.model}`, import.meta.url).pathname,
    { ...config, motion: { ...config.motion, rest: "none" } }, "none");
  assert.throws(() => powerStance(root, { kneeBend: NaN }), /finite/);
  const before = [];
  root.traverse((bone) => { if (bone.isBone) before.push([bone, bone.quaternion.clone(), bone.position.clone()]); });
  const clip = powerStance(root);
  assert.equal(clip.name, POWER_STANCE);
  for (const [bone, quaternion, position] of before) {
    assert.ok(bone.quaternion.equals(quaternion) && bone.position.equals(position), `${bone.name} must be restored`);
  }
});

test("motion.stance accepts known options in range and only with the power stance", () => {
  const base = configs.find(({ slug }) => slug === "demo-boxing-men");
  const withStance = (motion) => structuredClone({ ...base, motion: { ...base.motion, ...motion } });
  assert.doesNotThrow(() => validateConfig(withStance({ stance: { handForward: 0, kneeBend: 0.05 } }), `${base.slug}.json`));
  assert.throws(() => validateConfig(withStance({ stance: { elbowFlare: 1 } }), `${base.slug}.json`), /not a stance option/);
  assert.throws(() => validateConfig(withStance({ stance: { kneeBend: 0.5 } }), `${base.slug}.json`), /from 0 to 0.1/);
  assert.throws(() => validateConfig(withStance({ rest: "Idle", stance: {} }), `${base.slug}.json`), /requires motion.rest/);
});
