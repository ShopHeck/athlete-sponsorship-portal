import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import { buildRobe } from "../public/robe.js";
import { loadPosed } from "./refit-placements.mjs";

const RAYS = {
  front: (x, y) => [new THREE.Vector3(x, y, 3), new THREE.Vector3(0, 0, -1)],
  back: (x, y) => [new THREE.Vector3(x, y, -3), new THREE.Vector3(0, 0, 1)],
  left: (x, y) => [new THREE.Vector3(3, y, x), new THREE.Vector3(-1, 0, 0)],
  right: (x, y) => [new THREE.Vector3(-3, y, -x), new THREE.Vector3(1, 0, 0)]
};
const tenantsDir = new URL("../tenants/", import.meta.url);
const configs = [];
for (const file of (await readdir(tenantsDir)).filter((name) => name.endsWith(".json"))) {
  const config = JSON.parse(await readFile(new URL(file, tenantsDir), "utf8"));
  if (config.garments.some((garment) => garment.robe)) configs.push(config);
}

// A static snapshot of a skinned mesh as currently posed, restricted to triangles inside a height band (and, if given,
// to vertices bound mainly to bones matching `bones`), so many rays can be cast against it cheaply.
function snapshot(mesh, minY, maxY, bones) {
  mesh.updateMatrixWorld(true);
  mesh.skeleton.update();
  const pos = mesh.geometry.attributes.position, index = mesh.geometry.index;
  const world = new Float32Array(pos.count * 3), v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld).toArray(world, i * 3);
  const { skinIndex, skinWeight } = mesh.geometry.attributes;
  const joints = bones && new Set(mesh.skeleton.bones.flatMap((b, i) => bones.test(b.name) ? [i] : []));
  const bound = (t) => {
    if (!joints) return true;
    let w = 0;
    for (let k = 0; k < 4; k++) if (joints.has(skinIndex.getComponent(t, k))) w += skinWeight.getComponent(t, k);
    return w > 0.5;
  };
  const keep = [];
  for (let i = 0; i < index.count; i += 3) {
    const tri = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
    if (tri.some((t) => world[t * 3 + 1] >= minY && world[t * 3 + 1] <= maxY) && tri.every(bound)) keep.push(...tri);
  }
  const geometry = new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(world, 3)).setIndex(keep);
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
}

test("only the boxing demo wears a robe, after its kit, with valid colours", () => {
  assert.deepEqual(configs.map((c) => c.slug), ["demo-boxing-men"]);
  for (const config of configs) {
    const robe = config.garments.find((garment) => garment.robe);
    assert.notEqual(config.garments[0], robe, "the kit, not the robe, is the landing garment");
    assert.match(robe.robe.color, /^#[0-9a-f]{6}$/i);
    assert.match(robe.robe.trim, /^#[0-9a-f]{6}$/i);
    assert.ok(robe.placements.length >= 6, "the robe adds a full set of sponsor placements");
  }
});

for (const config of configs) {
  test(`${config.slug}: every robe placement lands on the robe, clear of the hands, and the robe covers the kit in every move`, async () => {
    const file = new URL(`../public/tenants/${config.slug}/${config.model}`, import.meta.url).pathname;
    const { root, meshes, motion } = await loadPosed(file, config, config.motion.rest);
    const body = meshes.find((mesh) => mesh.isSkinnedMesh);
    const garment = config.garments.find((g) => g.robe);
    let robe;
    motion.withProjectionPose(() => {
      robe = buildRobe(body, garment.robe);
      assert.ok(robe, "the rig has the bones a robe needs");
      const hands = [];
      const { skinIndex, skinWeight } = body.geometry.attributes;
      const handJoints = new Set(body.skeleton.bones.flatMap((b, i) => /Hand$/.test(b.name) ? [i] : []));
      for (let i = 0; i < skinIndex.count; i++) {
        let w = 0;
        for (let k = 0; k < 4; k++) if (handJoints.has(skinIndex.getComponent(i, k))) w += skinWeight.getComponent(i, k);
        if (w > 0.5) hands.push(body.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(body.matrixWorld));
      }
      for (const spot of garment.placements) {
        for (const side of new Set([spot.side, spot.mirror].filter(Boolean))) {
          const mirrored = side !== spot.side;
          // The whole print area must be on robe fabric, in front of the body.
          for (const [fx, fy] of [[0, 0], [-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) {
            const x = (mirrored ? -spot.x : spot.x) + fx * spot.w, y = spot.y + fy * spot.h;
            const [origin, direction] = RAYS[side](x, y);
            const onRobe = new THREE.Raycaster(origin, direction).intersectObject(robe)[0];
            assert.ok(onRobe, `${spot.id} (${side}) corner ${fx},${fy} must land on the robe`);
            const onBody = new THREE.Raycaster(origin, direction).intersectObject(body)[0];
            assert.ok(!onBody || onBody.distance > onRobe.distance, `${spot.id} (${side}) must sit on the robe, not under it`);
          }
          const [origin, direction] = RAYS[side](mirrored ? -spot.x : spot.x, spot.y);
          const hit = new THREE.Raycaster(origin, direction).intersectObject(robe)[0];
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

    // The kit must stay hidden under the satin: across the trunks, rays from the front and back meet the robe before
    // the hips and thighs (gloves may pass in front of it), in the stance and through every move.
    // From just above the hem (5 cm over the knees) to the top of the waistband.
    const kit = config.garments.filter((g) => !g.robe).flatMap((g) => g.placements);
    const knee = root.getObjectByName("LeftLeg").getWorldPosition(new THREE.Vector3()).y;
    const low = knee + 0.1, high = Math.max(...kit.map((p) => p.y + p.h / 2));
    const check = (label) => {
      const bodyNow = snapshot(body, low - 0.05, high + 0.05, /^(Hips|Spine02|(Left|Right)UpLeg)$/), robeNow = snapshot(robe, low - 0.1, high + 0.1);
      for (const side of ["front", "back"]) for (let x = -0.24; x <= 0.241; x += 0.03) for (let y = low; y <= high; y += 0.04) {
        const ray = new THREE.Raycaster(...RAYS[side](x, y));
        const b = ray.intersectObject(bodyNow)[0];
        if (!b) continue;
        const r = ray.intersectObject(robeNow)[0];
        assert.ok(r && r.distance < b.distance - 0.002, `${label}: the body shows through the robe at ${side} ${x.toFixed(2)}, ${y.toFixed(2)}`);
      }
    };
    check("stance");
    for (const { name } of motion.moves) {
      motion.play(name);
      for (let t = 0; motion.playing === name; t++) {
        motion.update(1 / 30);
        if (t % 9 === 8) { root.updateMatrixWorld(true); check(`${name} at ${((t + 1) / 30).toFixed(1)} s`); }
      }
      for (let i = 0; i < 40; i++) motion.update(1 / 30);
    }
  });
}
