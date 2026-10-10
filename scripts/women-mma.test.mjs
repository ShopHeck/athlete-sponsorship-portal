import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { cloneDocument } from "@gltf-transform/functions";
import draco from "draco3dgltf";
import sharp from "sharp";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createMotion } from "../public/motion.js";
import { deformSurface, fightStance } from "./prepare-model-stance.mjs";

const config = JSON.parse(await readFile(new URL("../tenants/demo-mma-women.json", import.meta.url)));
const spec = JSON.parse(await readFile(new URL("./demo-models/demo-mma-women-stance.json", import.meta.url)));
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.decoder": await draco.createDecoderModule()
});
const base = new URL("../public/tenants/demo-mma-women/", import.meta.url);
const source = await io.read(new URL("models/demo-mma-women-animated.glb", base).pathname);
const ready = await io.read(new URL(config.model, base).pathname);

async function load(document) {
  const copy = cloneDocument(document);
  for (const extension of copy.getRoot().listExtensionsUsed()) {
    if (extension.extensionName === "KHR_draco_mesh_compression") extension.dispose();
  }
  for (const material of copy.getRoot().listMaterials()) {
    material.setBaseColorTexture(null).setNormalTexture(null).setMetallicRoughnessTexture(null)
      .setOcclusionTexture(null).setEmissiveTexture(null);
  }
  const bytes = await io.writeBinary(copy);
  return new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
}

test("Rosa opens in the new rest stance and keeps both distinct front sports-bra slots", () => {
  // The offline Fight_Stance clip stays in the GLB; the portal now synthesizes the shared Power_Stance instead.
  assert.equal(config.motion.rest, "Power_Stance");
  assert.ok(ready.getRoot().listAnimations().some((clip) => clip.getName() === spec.rest));
  assert.equal(config.motion.intro, undefined);
  assert.ok(config.demo);
  const placements = config.garments.flatMap((garment) => garment.placements);
  const lower = placements.find(({ id }) => id === "TF-01");
  const upper = placements.find(({ id }) => id === "TF-02");
  assert.equal(lower.side, "front");
  assert.equal(upper.side, "front");
  assert.ok(lower.y + lower.h / 2 + 0.01 < upper.y - upper.h / 2);
  assert.match(lower.label, /lower panel/);
});

test("offline preparation preserves the rig, texture bytes and all seven original moves", () => {
  const transforms = (doc) => doc.getRoot().listNodes().map((node) => ({
    name: node.getName(), translation: node.getTranslation(), rotation: node.getRotation(), scale: node.getScale(),
    children: node.listChildren().map((child) => child.getName())
  }));
  assert.deepEqual(transforms(ready), transforms(source));
  assert.deepEqual(ready.getRoot().listTextures().map((texture) => Buffer.from(texture.getImage())),
    source.getRoot().listTextures().map((texture) => Buffer.from(texture.getImage())));
  const skins = (doc) => doc.getRoot().listSkins().map((skin) => ({
    joints: skin.listJoints().map((joint) => joint.getName()), inverses: [...skin.getInverseBindMatrices().getArray()]
  }));
  assert.deepEqual(skins(ready), skins(source));
  const clips = (doc) => doc.getRoot().listAnimations().map((clip) => ({
    name: clip.getName(), channels: clip.listChannels().map((channel) => ({
      node: channel.getTargetNode().getName(), path: channel.getTargetPath(),
      interpolation: channel.getSampler().getInterpolation(),
      input: [...channel.getSampler().getInput().getArray()], output: [...channel.getSampler().getOutput().getArray()]
    }))
  }));
  assert.deepEqual(clips(ready).filter(({ name }) => name !== spec.rest), clips(source));
  assert.equal(ready.getRoot().listAnimations().filter((clip) => clip.getName() === spec.rest).length, 1);
});

test("the arms stay beside the thighs, feet are planted and settling restores the authored pose", async () => {
  const gltf = await load(ready), root = gltf.scene;
  const box = new THREE.Box3().setFromObject(root);
  root.scale.setScalar(1.86 / box.getSize(new THREE.Vector3()).y);
  box.setFromObject(root);
  root.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  root.updateMatrixWorld(true);
  const motion = createMotion(root, gltf.animations, config.motion.clips, { rest: config.motion.rest });
  const point = (name) => root.getObjectByName(name).getWorldPosition(new THREE.Vector3());
  const hip = point("Hips");
  for (const side of ["Left", "Right"]) {
    const hand = point(`${side}Hand`), shoulder = point(`${side}Arm`);
    assert.ok(hand.y < hip.y - 0.05);
    assert.ok(Math.abs(hand.x - shoulder.x) < 0.15);
    assert.ok(Math.abs(hand.x - hip.x) > 0.28, "Gloves must clear the shorts");
  }
  assert.ok(point("LeftFoot").x - point("RightFoot").x > 0.35);
  assert.ok(Math.abs(point("LeftFoot").z - point("RightFoot").z) < 0.08, "The power stance is square-on");
  root.traverse((mesh) => {
    if (!mesh.isSkinnedMesh) return;
    mesh.skeleton.update();
    for (const side of ["Left", "Right"]) {
      const joints = mesh.skeleton.bones.flatMap((bone, i) =>
        [side + "Foot", side + "ToeBase"].includes(bone.name) ? [i] : []);
      const { skinIndex, skinWeight, position } = mesh.geometry.attributes;
      let floor = Infinity;
      for (let i = 0; i < position.count; i++) {
        let weight = 0;
        for (let k = 0; k < 4; k++) if (joints.includes(skinIndex.getComponent(i, k))) weight += skinWeight.getComponent(i, k);
        if (weight > 0.8) floor = Math.min(floor, mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld).y);
      }
      assert.ok(Math.abs(floor) < 0.006, `${side} foot floor offset: ${floor}`);
    }
  });
  const rest = new Map();
  root.traverse((bone) => { if (bone.isBone) rest.set(bone.name, bone.quaternion.clone()); });
  for (const { clip } of config.motion.clips) {
    motion.play(clip);
    for (let i = 0; i < 90; i++) motion.update(1 / 60);
    motion.settle();
    for (let i = 0; i < 90; i++) motion.update(1 / 60);
    for (const [name, quaternion] of rest) assert.ok(root.getObjectByName(name).quaternion.angleTo(quaternion) < 0.001);
  }
});

test("both complete front placement rectangles sample dark sports-bra fabric, not skin", async () => {
  const gltf = await load(ready), root = gltf.scene;
  const box = new THREE.Box3().setFromObject(root);
  root.scale.setScalar(1.86 / box.getSize(new THREE.Vector3()).y);
  box.setFromObject(root);
  root.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  root.updateMatrixWorld(true);
  const motion = createMotion(root, gltf.animations, config.motion.clips, { rest: config.motion.rest });
  const texture = ready.getRoot().listMaterials()[0].getBaseColorTexture().getImage();
  const { data, info } = await sharp(texture).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const meshes = [];
  root.traverse((mesh) => { if (mesh.isSkinnedMesh) meshes.push(mesh); });
  motion.withProjectionPose(() => {
    for (const mesh of meshes) { mesh.skeleton.update(); mesh.computeBoundingBox(); mesh.computeBoundingSphere(); }
    for (const slot of config.garments.flatMap((garment) => garment.placements).filter(({ id }) => ["TF-01", "TF-02"].includes(id))) {
      for (let x = 0; x <= 8; x++) for (let y = 0; y <= 6; y++) {
        const hit = new THREE.Raycaster(new THREE.Vector3(slot.x + (x / 8 - 0.5) * slot.w,
          slot.y + (y / 6 - 0.5) * slot.h, 3), new THREE.Vector3(0, 0, -1)).intersectObjects(meshes)[0];
        assert.ok(hit?.uv, `${slot.id} is missing fabric at sample ${x},${y}`);
        const px = Math.min(info.width - 1, Math.max(0, Math.round(hit.uv.x * (info.width - 1))));
        const py = Math.min(info.height - 1, Math.max(0, Math.round(hit.uv.y * (info.height - 1))));
        const rgb = [...data.subarray((py * info.width + px) * 4, (py * info.width + px) * 4 + 3)];
        assert.ok(Math.max(...rgb) < 100, `${slot.id} hits light skin at ${x},${y}: ${rgb}`);
      }
    }
  });
});

test("the smirk uses a small, local, seam-safe surface warp with normalized normals", () => {
  const doc = new Document(), buffer = doc.createBuffer();
  const positions = doc.createAccessor().setType("VEC3").setBuffer(buffer)
    .setArray(new Float32Array([.025, 1.516, .082, .025, 1.516, .082, 0, .9, .1]));
  const normals = doc.createAccessor().setType("VEC3").setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 0]));
  const uv = doc.createAccessor().setType("VEC2").setBuffer(buffer).setArray(new Float32Array([0, 0, 1, 1, .5, .5]));
  const primitive = doc.createPrimitive().setAttribute("POSITION", positions).setAttribute("NORMAL", normals).setAttribute("TEXCOORD_0", uv);
  deformSurface(primitive, spec.surfaceDeformations);
  const result = positions.getArray();
  assert.ok(Math.abs(result[1] - 1.52) < 1e-6);
  assert.deepEqual([...result.slice(0, 3)], [...result.slice(3, 6)], "Texture seams must receive the same displacement");
  assert.deepEqual([...result.slice(6)], [0, new Float32Array([.9])[0], new Float32Array([.1])[0]]);
  assert.equal(primitive.getAttribute("TEXCOORD_0"), uv);
  for (let i = 0; i < normals.getCount(); i++) assert.ok(Math.abs(new THREE.Vector3().fromArray(normals.getArray(), i * 3).length() - 1) < 1e-6);
  assert.throws(() => deformSurface(primitive, [{ center: [0, 0, 0], radius: [0, 1, 1], displacement: [0, 0, 0] }]), /positive radii/);
  assert.throws(() => deformSurface(primitive, [{ center: [0, 0, 0], radius: [1, 1, 1], displacement: [0, 1, 0] }]), /too large/);
  assert.throws(() => fightStance(new THREE.Group(), new THREE.AnimationClip("Idle")), /requires Hips/);
  assert.throws(() => fightStance(new THREE.Group(), new THREE.AnimationClip("Idle"), { chinDegrees: NaN }), /finite degrees/);
});
