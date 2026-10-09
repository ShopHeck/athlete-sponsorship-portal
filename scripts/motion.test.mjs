import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco from "draco3dgltf";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createMotion } from "../public/motion.js";

const slug = "michael-heckert";
const config = JSON.parse(await fs.readFile(new URL(`../tenants/${slug}.json`, import.meta.url)));

test("Michael offers only an on-demand Jab and Victory", () => {
  assert.equal(config.motion.intro, undefined);
  assert.deepEqual(config.motion.clips.map(({ label }) => label), ["Jab", "Victory"]);
});

test("one guarded Jab and rig-directed three-beat Victory return to the sponsor stance", async () => {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    "draco3d.decoder": await draco.createDecoderModule()
  });
  const doc = await io.read(new URL(`../public/tenants/${slug}/${config.model}`, import.meta.url).pathname);
  for (const extension of doc.getRoot().listExtensionsUsed()) {
    if (extension.extensionName === "KHR_draco_mesh_compression") extension.dispose();
  }
  for (const material of doc.getRoot().listMaterials()) {
    material.setBaseColorTexture(null).setNormalTexture(null).setMetallicRoughnessTexture(null)
      .setOcclusionTexture(null).setEmissiveTexture(null);
  }
  const bytes = await io.writeBinary(doc);
  const gltf = await new GLTFLoader().parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), ""
  );
  const root = gltf.scene;
  const height = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3()).y;
  root.scale.setScalar(1.86 / height);
  root.updateMatrixWorld(true);
  const changes = [];
  const motion = createMotion(root, gltf.animations, config.motion.clips,
    { rest: config.motion.rest, onChange: (name) => changes.push(name) });
  assert.deepEqual(motion.moves.map(({ label }) => label), ["Jab", "Victory"]);
  const point = (name) => root.getObjectByName(name).getWorldPosition(new THREE.Vector3());
  const contactGap = () => {
    let nearest = Infinity;
    root.traverse((mesh) => {
      if (!mesh.isSkinnedMesh) return;
      mesh.skeleton.update();
      const { skinIndex, skinWeight, position } = mesh.geometry.attributes;
      const hand = mesh.skeleton.bones.findIndex((b) => b.name === "LeftHand");
      const spines = mesh.skeleton.bones.map((b, i) => /^Spine\d*$/.test(b.name) ? i : -1).filter((i) => i >= 0);
      const influence = (vertex, joint) => {
        let weight = 0;
        for (let k = 0; k < 4; k++) {
          if (skinIndex.getComponent(vertex, k) === joint) weight += skinWeight.getComponent(vertex, k);
        }
        return weight;
      };
      const posed = new Float32Array(position.count * 3);
      const v = new THREE.Vector3();
      for (let i = 0; i < position.count; i++) mesh.getVertexPosition(i, v).toArray(posed, i * 3);
      const indices = [], index = mesh.geometry.index;
      for (let i = 0; i < (index?.count ?? position.count); i += 3) {
        const face = [0, 1, 2].map((k) => index ? index.getX(i + k) : i + k);
        if (face.every((vertex) => spines.reduce((sum, joint) => sum + influence(vertex, joint), 0) > 0.5)) indices.push(...face);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(posed, 3));
      geometry.setIndex(indices);
      const torso = new THREE.Mesh(geometry, mesh.material);
      torso.matrixWorld.copy(mesh.matrixWorld);
      const shoulder = point("LeftArm");
      for (let i = 0; i < position.count; i++) {
        if (influence(i, hand) < 0.8) continue;
        const p = new THREE.Vector3().fromArray(posed, i * 3).applyMatrix4(mesh.matrixWorld);
        if (Math.abs(p.x) > 0.08 || p.y > shoulder.y - 0.06 || p.y < shoulder.y - 0.24) continue;
        const ray = new THREE.Raycaster(new THREE.Vector3(p.x, p.y, 3), new THREE.Vector3(0, 0, -1));
        const chest = ray.intersectObject(torso)[0];
        if (chest) nearest = Math.min(nearest, p.z - chest.point.z);
      }
      geometry.dispose();
    });
    return nearest;
  };
  const leftAtRest = point("LeftHand");
  const rightAtRest = point("RightHand");
  let time = 0;
  const advance = (to, snapshots = {}) => {
    while (time < to - 1e-8) {
      const step = Math.min(1 / 120, to - time);
      motion.update(step);
      time += step;
    }
    root.updateMatrixWorld(true);
    snapshots[to] = { left: point("LeftHand"), right: point("RightHand"),
      elbow: point("RightForeArm"), shoulder: point("RightArm") };
    if ([1.6, 2.05, 2.5].includes(to)) snapshots[to].gap = contactGap();
  };

  motion.play("Left_Jab_from_Guard");
  const jab = {};
  for (const t of [0.4, 0.6, 1.1, 1.65, 2.35, 3, 4]) advance(t, jab);
  assert.ok(jab[0.6].left.y > leftAtRest.y + 0.25, "the guard must rise before striking");
  assert.equal(motion.playing, null, "one Jab must finish rather than repeat");
  assert.ok(jab[4].left.distanceTo(leftAtRest) < 0.01, "the arms must return to rest");
  assert.deepEqual(changes, ["Left_Jab_from_Guard", null]);

  time = 0;
  motion.play("Victory_Chest_Beat");
  const victory = {};
  for (const t of [0.5, 1.6, 1.82, 2.05, 2.27, 2.5, 4.9]) advance(t, victory);
  for (const t of [1.6, 2.05, 2.5]) {
    assert.ok(victory[t].right.y > victory[t].shoulder.y + 0.38, "the fist must be raised");
    assert.ok(victory[t].elbow.z > victory[t].shoulder.z + 0.04, "the elbow must face forward");
    assert.ok(victory[t].right.z > victory[t].shoulder.z + 0.12, "the fist must not turn behind him");
    assert.ok(victory[t].gap < 0.01 && victory[t].gap > -0.02,
      `the wrapped fist must touch the chest without deep penetration (gap ${victory[t].gap})`);
  }
  for (const [beat, lift] of [[1.6, 1.82], [2.05, 2.27]]) {
    assert.ok(victory[lift].left.z > victory[beat].left.z + 0.06, "the fist must release between beats");
  }
  assert.ok(victory[4.9].left.distanceTo(leftAtRest) < 0.01);
  assert.ok(victory[4.9].right.distanceTo(rightAtRest) < 0.01);
  assert.deepEqual(changes, ["Left_Jab_from_Guard", null, "Victory_Chest_Beat", null]);
});
