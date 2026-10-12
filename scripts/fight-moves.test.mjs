import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";
import { BUMP_OUT, TAP_OUT, TAUNT_BUMPS, TAUNT_TAPS } from "../public/motion.js";
import { loadPosed } from "./refit-placements.mjs";

const tenantsDir = new URL("../tenants/", import.meta.url);
const configs = [];
for (const file of (await readdir(tenantsDir)).filter((name) => name.endsWith(".json"))) {
  const config = JSON.parse(await readFile(new URL(file, tenantsDir), "utf8"));
  if (config.demo && config.motion) configs.push(config);
}
const MOVES = [["Victory_Chest_Beat", "Victory"], ["Shadowbox_Combo", "Shadowbox"], ["Taunt_Hands_Down", "Taunt"]];
const STEP = 1 / 60;

test("every demo fighter offers Michael Heckert's Victory, the authored Shadowbox and Taunt, and opens with the Taunt", () => {
  assert.equal(configs.length, 7);
  for (const config of configs) {
    assert.deepEqual(config.motion.clips.map(({ clip, label }) => [clip, label]), MOVES, config.slug);
    assert.ok([undefined, "Taunt_Hands_Down"].includes(config.motion.intro), config.slug);
  }
});

// Faces whose vertices are mostly skinned to the spine, posed as they are now, so a fist can be measured against
// the chest without hitting the arm it belongs to.
function torsoSurface(meshes) {
  return meshes.filter((mesh) => mesh.isSkinnedMesh).map((mesh) => {
    mesh.skeleton.update();
    const { skinIndex, skinWeight, position } = mesh.geometry.attributes;
    const spines = mesh.skeleton.bones.map((b, i) => /^Spine\d*$/.test(b.name) ? i : -1).filter((i) => i >= 0);
    const onSpine = (v) => {
      let w = 0;
      for (let k = 0; k < 4; k++) if (spines.includes(skinIndex.getComponent(v, k))) w += skinWeight.getComponent(v, k);
      return w > 0.5;
    };
    const posed = new Float32Array(position.count * 3), p = new THREE.Vector3();
    for (let i = 0; i < position.count; i++) mesh.getVertexPosition(i, p).applyMatrix4(mesh.matrixWorld).toArray(posed, i * 3);
    const indices = [], index = mesh.geometry.index;
    for (let i = 0; i < (index?.count ?? position.count); i += 3) {
      const face = [0, 1, 2].map((k) => index ? index.getX(i + k) : i + k);
      if (face.every(onSpine)) indices.push(...face);
    }
    const geometry = new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(posed, 3)).setIndex(indices);
    return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  });
}

function handVertices(meshes, name) {
  return meshes.filter((mesh) => mesh.isSkinnedMesh).flatMap((mesh) => {
    const { skinIndex, skinWeight, position } = mesh.geometry.attributes;
    const joint = mesh.skeleton.bones.findIndex((b) => b.name === name), out = [];
    for (let i = 0; i < position.count; i++) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (skinIndex.getComponent(i, k) === joint) w += skinWeight.getComponent(i, k);
      if (w > 0.5) out.push(mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld));
    }
    return out;
  });
}

for (const config of configs) {
  test(`${config.slug}: each move stays planted, upright and facing the sponsor, then returns to the stance`, async () => {
    const file = new URL(`../public/tenants/${config.slug}/${config.model}`, import.meta.url).pathname;
    const { root, meshes, motion } = await loadPosed(file, config, config.motion.rest);
    assert.deepEqual(motion.moves.map(({ name, label }) => [name, label]), MOVES);
    const point = (name) => root.getObjectByName(name).getWorldPosition(new THREE.Vector3());
    const rest = new Map();
    root.traverse((bone) => { if (bone.isBone) rest.set(bone.name, bone.quaternion.clone()); });
    const feet = ["LeftFoot", "RightFoot"].map((name) => [name, point(name)]);
    const hips = point("Hips"), head = point("Head");
    const armLength = point("LeftArm").distanceTo(point("LeftForeArm")) + point("LeftForeArm").distanceTo(point("LeftHand"));
    // Facing is judged on the horizontal heading: the Victory bows the head, which is not turning away.
    const facing = (name) => new THREE.Vector3(0, 0, 1).applyQuaternion(root.getObjectByName(name).getWorldQuaternion(new THREE.Quaternion()))
      .setY(0).normalize();
    const restFacing = { Hips: facing("Hips"), Head: facing("Head") };
    // How far the side's fist is in front of the chest at its closest (negative: sunk into it).
    const onChest = (side) => {
      const torso = torsoSurface(meshes);
      let gap = Infinity;
      for (const p of handVertices(meshes, `${side}Hand`)) {
        const hit = new THREE.Raycaster(new THREE.Vector3(p.x, p.y, 3), new THREE.Vector3(0, 0, -1)).intersectObjects(torso)[0];
        if (hit) gap = Math.min(gap, p.z - hit.point.z);
      }
      return gap;
    };
    const near = (t, peaks, out) => peaks.some((start) => Math.abs(t - (start + out + 0.02)) < STEP / 2);

    for (const [name] of MOVES) {
      motion.play(name);
      let frames = 0, highest = -Infinity, longestJab = 0;
      const beats = [], bumps = [], taps = [];
      while (motion.playing === name) {
        motion.update(STEP);
        frames++;
        const t = frames * STEP;
        assert.ok(frames < 6 * 60, `${name} must end on its own`);
        for (const [foot, at] of feet) {
          assert.ok(point(foot).distanceTo(at) < 0.01, `${name}: ${foot} must stay planted (frame ${frames})`);
        }
        const h = point("Hips");
        assert.ok(Math.hypot(h.x - hips.x, h.z - hips.z) < 0.01, `${name}: the hips must not travel`);
        assert.ok(h.y > hips.y - 0.06, `${name}: no deep crouch (hips ${(hips.y - h.y).toFixed(3)} m down)`);
        assert.ok(point("Head").y > head.y - 0.08, `${name}: the head must not duck`);
        for (const bone of ["Hips", "Head"]) {
          const angle = THREE.MathUtils.radToDeg(facing(bone).angleTo(restFacing[bone]));
          assert.ok(angle < 35, `${name}: ${bone} turned ${angle.toFixed(0)}° away from the sponsor`);
        }
        highest = Math.max(highest, point("RightHand").y);
        longestJab = Math.max(longestJab, point("LeftHand").z - point("LeftArm").z);
        if (name === "Victory_Chest_Beat" && [1.6, 2.05, 2.5].some((peak) => Math.abs(t - peak) < STEP / 2)) beats.push(onChest("Left"));
        if (name === "Taunt_Hands_Down" && near(t, TAUNT_BUMPS, BUMP_OUT)) {
          const inner = (side, sign) => Math.min(...handVertices(meshes, `${side}Hand`).map((p) => sign * p.x));
          bumps.push(inner("Left", 1) + inner("Right", -1));
        }
        if (name === "Taunt_Hands_Down" && near(t, TAUNT_TAPS, TAP_OUT)) {
          const face = handVertices(meshes, "Head");
          taps.push(Math.min(...handVertices(meshes, "RightHand").map((p) => Math.min(...face.map((q) => p.distanceTo(q))))));
        }
      }
      if (name === "Victory_Chest_Beat") {
        assert.ok(highest > head.y + 0.15, `the right fist must go up overhead (${highest.toFixed(2)})`);
        assert.equal(beats.length, 3);
        for (const gap of beats) assert.ok(gap > -0.015 && gap < 0.02, `each beat must land on the chest, not in it (${gap.toFixed(3)} m)`);
      }
      if (name === "Shadowbox_Combo") assert.ok(longestJab > 0.75 * armLength, `the jab must extend (${(longestJab / armLength).toFixed(2)} arm)`);
      if (name === "Taunt_Hands_Down") {
        assert.equal(bumps.length, 2);
        for (const gap of bumps) assert.ok(gap > -0.02 && gap < 0.015, `the gloves must meet when they bump (${gap.toFixed(3)} m apart)`);
        assert.equal(taps.length, 2);
        for (const gap of taps) assert.ok(gap < 0.03, `the right fist must reach the chin (${gap.toFixed(3)} m away)`);
      }
      for (let i = 0; i < 60; i++) motion.update(STEP);
      for (const [bone, quaternion] of rest) {
        assert.ok(root.getObjectByName(bone).quaternion.angleTo(quaternion) < 0.001, `${name} must end in the stance (${bone})`);
      }
    }
  });
}

test("moves and their blends are smooth: no bone's angular speed jumps between frames", async () => {
  // Peak angular acceleration of the arms, head and chest at 120 Hz, from the stance through each move and back. Old
  // linear fades and full-speed punch starts reached 1100-6000 rad/s²; eased blends and curves stay well below 1500.
  for (const slug of ["demo-nogi-men", "demo-boxing-women"]) {
    const config = configs.find((c) => c.slug === slug);
    const { root, motion } = await loadPosed(new URL(`../public/tenants/${slug}/${config.model}`, import.meta.url).pathname, config, config.motion.rest);
    const bones = ["LeftForeArm", "RightForeArm", "LeftHand", "RightHand", "Head", "Spine"].map((n) => root.getObjectByName(n));
    const dt = 1 / 120;
    for (const { name } of motion.moves) {
      motion.play(name);
      let previous = bones.map((b) => b.getWorldQuaternion(new THREE.Quaternion())), speeds = bones.map(() => 0), peak = 0;
      for (let frame = 0; frame < 6 / dt; frame++) {
        motion.update(dt);
        root.updateMatrixWorld(true);
        bones.forEach((bone, i) => {
          const q = bone.getWorldQuaternion(new THREE.Quaternion());
          const speed = q.angleTo(previous[i]) / dt;
          if (frame > 1) peak = Math.max(peak, Math.abs(speed - speeds[i]) / dt);
          previous[i] = q; speeds[i] = speed;
        });
      }
      assert.ok(peak < 1500, `${slug} ${name}: angular acceleration peaks at ${peak.toFixed(0)} rad/s²`);
    }
  }
});

test("the breathing idle loops seamlessly, stays subtle and keeps the feet planted", async () => {
  const config = configs.find((c) => c.slug === "demo-mma-women");
  const file = new URL(`../public/tenants/${config.slug}/${config.model}`, import.meta.url).pathname;
  const { root } = await loadPosed(file, { ...config, motion: { ...config.motion, rest: "none" } }, "none");
  const { createMotion } = await import("../public/motion.js");
  const motion = createMotion(root, [], config.motion.clips, { rest: config.motion.rest, idle: true });
  const point = (name) => root.getObjectByName(name).getWorldPosition(new THREE.Vector3());
  const pose = () => { const out = new Map(); root.traverse((b) => { if (b.isBone) out.set(b.name, b.quaternion.clone()); }); return out; };
  const start = pose(), feet = ["LeftFoot", "RightFoot"].map((n) => point(n));
  let widest = 0;
  for (let frame = 1; frame <= 8 * 30; frame++) {
    assert.ok(motion.update(1 / 30), "breathing keeps the body moving");
    root.updateMatrixWorld(true);
    ["LeftFoot", "RightFoot"].forEach((n, i) => assert.ok(point(n).distanceTo(feet[i]) < 0.005, `${n} must stay planted`));
    for (const [name, q] of pose()) widest = Math.max(widest, THREE.MathUtils.radToDeg(q.angleTo(start.get(name))));
  }
  assert.ok(widest > 0.5 && widest < 4, `breathing moves bones by up to ${widest.toFixed(2)}°`);
  assert.equal(motion.active, false, "breathing alone is not a move");
  for (const [name, q] of pose()) assert.ok(q.angleTo(start.get(name)) < 0.002, `${name} must return to its first frame after one loop`);
});
