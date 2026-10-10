import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco from "draco3dgltf";
import sharp from "sharp";
import * as THREE from "three";
import { deformSurface, fightStance } from "./prepare-model-stance.mjs";
import { loadPosed } from "./refit-placements.mjs";

const config = JSON.parse(await readFile(new URL("../tenants/demo-mma-women.json", import.meta.url)));
const file = new URL(`../public/tenants/demo-mma-women/${config.model}`, import.meta.url).pathname;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.decoder": await draco.createDecoderModule()
});
const placements = config.garments.flatMap((garment) => garment.placements);

test("Rosa rests in the power stance and keeps two distinct front sports-top slots", () => {
  assert.equal(config.motion.rest, "Power_Stance");
  assert.equal(config.motion.intro, undefined);
  assert.ok(config.demo);
  const lower = placements.find(({ id }) => id === "TF-01");
  const upper = placements.find(({ id }) => id === "TF-02");
  assert.equal(lower.side, "front");
  assert.equal(upper.side, "front");
  assert.ok(lower.y + lower.h / 2 + 0.01 < upper.y - upper.h / 2);
  assert.match(lower.label, /lower panel/);
});

test("Rosa's model is rigged with all seven moves and her open-finger gloves", async () => {
  const doc = await io.read(file);
  assert.deepEqual(doc.getRoot().listAnimations().map((clip) => clip.getName()).sort(), [
    "Boxing_Practice", "Boxing_Warmup", "Chest_Pound_Taunt", "Dodge_and_Counter", "Idle", "Show_Both_Arm_Muscles", "Victory_Fist_Pump"
  ]);
  for (const { clip } of config.motion.clips) {
    assert.ok(doc.getRoot().listAnimations().some((animation) => animation.getName() === clip), `${clip} must be baked`);
  }
});

test("every placement rectangle samples fight-kit fabric, not skin", async () => {
  const { meshes, motion } = await loadPosed(file, config, config.motion.rest);
  const texture = (await io.read(file)).getRoot().listMaterials()[0].getBaseColorTexture().getImage();
  const { data, info } = await sharp(texture).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  // The kit is a black top and waistband and teal (#0f7c80) shorts; skin is warm, with red the strongest channel.
  const fabric = ([r, g, b]) => Math.max(r, g, b) < 100 || (g > r + 10 && b > r);
  const rays = {
    front: (x, y) => [new THREE.Vector3(x, y, 3), new THREE.Vector3(0, 0, -1)],
    back: (x, y) => [new THREE.Vector3(x, y, -3), new THREE.Vector3(0, 0, 1)]
  };
  motion.withProjectionPose(() => {
    for (const slot of placements) {
      for (let x = 0; x <= 8; x++) for (let y = 0; y <= 6; y++) {
        const hit = new THREE.Raycaster(...rays[slot.side](slot.x + (x / 8 - 0.5) * slot.w, slot.y + (y / 6 - 0.5) * slot.h))
          .intersectObjects(meshes)[0];
        assert.ok(hit?.uv, `${slot.id} is missing fabric at sample ${x},${y}`);
        const px = Math.min(info.width - 1, Math.max(0, Math.round(hit.uv.x * (info.width - 1))));
        const py = Math.min(info.height - 1, Math.max(0, Math.round(hit.uv.y * (info.height - 1))));
        const rgb = [...data.subarray((py * info.width + px) * 4, (py * info.width + px) * 4 + 3)];
        assert.ok(fabric(rgb), `${slot.id} hits skin at ${x},${y}: ${rgb}`);
      }
    }
  });
});

test("the offline stance tool's surface warp stays small, local, seam-safe and normalized", () => {
  const warp = [{ center: [0.025, 1.516, 0.082], radius: [0.014, 0.014, 0.03], displacement: [0, 0.004, 0] }];
  const doc = new Document(), buffer = doc.createBuffer();
  const positions = doc.createAccessor().setType("VEC3").setBuffer(buffer)
    .setArray(new Float32Array([.025, 1.516, .082, .025, 1.516, .082, 0, .9, .1]));
  const normals = doc.createAccessor().setType("VEC3").setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 0]));
  const uv = doc.createAccessor().setType("VEC2").setBuffer(buffer).setArray(new Float32Array([0, 0, 1, 1, .5, .5]));
  const primitive = doc.createPrimitive().setAttribute("POSITION", positions).setAttribute("NORMAL", normals).setAttribute("TEXCOORD_0", uv);
  deformSurface(primitive, warp);
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
