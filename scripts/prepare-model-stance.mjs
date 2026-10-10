import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { draco as compress } from "@gltf-transform/functions";
import draco from "draco3dgltf";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

function pointBone(bone, from, to) {
  const parent = bone.parent.getWorldQuaternion(new THREE.Quaternion());
  const swing = new THREE.Quaternion().setFromUnitVectors(from.normalize(), to.normalize());
  bone.quaternion.premultiply(parent.clone().invert().multiply(swing).multiply(parent));
  bone.updateMatrixWorld(true);
}

function pointLimb(upper, lower, end, target, pole) {
  const start = upper.getWorldPosition(new THREE.Vector3());
  const middle = lower.getWorldPosition(new THREE.Vector3());
  const tip = end.getWorldPosition(new THREE.Vector3());
  const a = start.distanceTo(middle), b = middle.distanceTo(tip);
  const direction = target.clone().sub(start).normalize();
  const reach = target.distanceTo(start);
  if (reach >= a + b || reach <= Math.abs(a - b)) throw new Error(`Unreachable stance target for ${upper.name}`);
  const along = (a ** 2 - b ** 2 + reach ** 2) / (2 * reach);
  const outward = pole.clone().projectOnPlane(direction).normalize();
  const desired = start.clone().addScaledVector(direction, along)
    .addScaledVector(outward, Math.sqrt(Math.max(0, a ** 2 - along ** 2)));
  pointBone(upper, middle.sub(start), desired.sub(start));
  const rotatedMiddle = lower.getWorldPosition(new THREE.Vector3());
  pointBone(lower, end.getWorldPosition(new THREE.Vector3()).sub(rotatedMiddle), target.clone().sub(rotatedMiddle));
}

export function fightStance(root, sourceClip, { chinDegrees = 0, palmTurnDegrees = 0 } = {}) {
  if (![chinDegrees, palmTurnDegrees].every(Number.isFinite)) throw new Error("Stance angles must be finite degrees");
  root.updateMatrixWorld(true);
  const bones = new Map();
  root.traverse((node) => {
    if (node.isBone) bones.set(node.name, {
      node, quaternion: node.quaternion.clone(), position: node.position.clone(),
      worldPosition: node.getWorldPosition(new THREE.Vector3()), worldQuaternion: node.getWorldQuaternion(new THREE.Quaternion())
    });
  });
  for (const name of ["Hips", "Head", ...["Left", "Right"].flatMap((side) =>
    ["Arm", "ForeArm", "Hand", "UpLeg", "Leg", "Foot", "ToeBase"].map((joint) => `${side}${joint}`))]) {
    if (!bones.has(name)) throw new Error(`Fight stance requires ${name}`);
  }
  for (const track of sourceClip.tracks) {
    const { nodeName, propertyName } = THREE.PropertyBinding.parseTrackName(track.name);
    const bone = bones.get(nodeName)?.node;
    if (bone && (propertyName === "quaternion" || (propertyName === "position" && nodeName === "Hips"))) {
      bone[propertyName].fromArray(track.values, 0);
    }
  }
  for (const [name, { node, quaternion, position }] of bones) {
    if (/^(Hips|Spine\d*|neck|Head|LeftShoulder|RightShoulder|LeftHand|RightHand)$/.test(name)) {
      node.quaternion.copy(quaternion);
    }
    if (name === "Hips") {
      node.position.x = position.x;
      node.position.z = position.z;
    }
  }
  root.updateMatrixWorld(true);
  for (const [side, sign] of [["Left", 1], ["Right", -1]]) {
    const arm = bones.get(`${side}Arm`).node, forearm = bones.get(`${side}ForeArm`).node, hand = bones.get(`${side}Hand`).node;
    const shoulder = arm.getWorldPosition(new THREE.Vector3()), elbow = forearm.getWorldPosition(new THREE.Vector3());
    const length = shoulder.distanceTo(elbow) + elbow.distanceTo(hand.getWorldPosition(new THREE.Vector3()));
    pointLimb(arm, forearm, hand, shoulder.clone().add(new THREE.Vector3(sign * length * 0.2, -length * 0.95, length * 0.06)),
      new THREE.Vector3(sign, 0, -0.1));
    const axis = hand.getWorldPosition(new THREE.Vector3()).sub(forearm.getWorldPosition(new THREE.Vector3())).normalize();
    const parent = forearm.parent.getWorldQuaternion(new THREE.Quaternion());
    const turn = new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(sign * palmTurnDegrees));
    forearm.quaternion.premultiply(parent.clone().invert().multiply(turn).multiply(parent));
    forearm.updateMatrixWorld(true);

    const foot = bones.get(`${side}Foot`), target = foot.node.getWorldPosition(new THREE.Vector3());
    target.y = foot.worldPosition.y;
    pointLimb(bones.get(`${side}UpLeg`).node, bones.get(`${side}Leg`).node, foot.node, target, new THREE.Vector3(sign * 0.1, 0, 1));
    foot.node.quaternion.copy(foot.node.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(foot.worldQuaternion));
    const toe = bones.get(`${side}ToeBase`);
    toe.node.quaternion.copy(toe.quaternion);
    root.updateMatrixWorld(true);
  }
  const head = bones.get("Head").node;
  head.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0),
    THREE.MathUtils.degToRad(chinDegrees)));
  root.updateMatrixWorld(true);
  return [...bones.values()].map(({ node }) => ({
    name: node.name, rotation: node.quaternion.toArray(),
    ...(node.name === "Hips" ? { translation: node.position.toArray() } : {})
  }));
}

function addStance(document, name, pose) {
  const nodes = new Map(document.getRoot().listNodes().map((node) => [node.getName(), node]));
  if (document.getRoot().listAnimations().some((animation) => animation.getName() === name)) {
    throw new Error(`Animation ${name} already exists`);
  }
  const buffer = document.getRoot().listBuffers()[0];
  const time = document.createAccessor().setType("SCALAR").setArray(new Float32Array([0, 1])).setBuffer(buffer);
  const animation = document.createAnimation(name);
  for (const joint of pose) {
    for (const path of ["rotation", "translation"]) {
      if (!joint[path]) continue;
      const output = document.createAccessor().setType(path === "rotation" ? "VEC4" : "VEC3")
        .setArray(new Float32Array([...joint[path], ...joint[path]])).setBuffer(buffer);
      const sampler = document.createAnimationSampler().setInput(time).setOutput(output).setInterpolation("LINEAR");
      animation.addSampler(sampler).addChannel(document.createAnimationChannel().setTargetNode(nodes.get(joint.name))
        .setTargetPath(path).setSampler(sampler));
    }
  }
}

export function deformSurface(primitive, deformations) {
  const position = primitive.getAttribute("POSITION"), normal = primitive.getAttribute("NORMAL");
  if (!position || !normal) throw new Error("Surface adjustments require positions and normals");
  const positions = new Float32Array(position.getArray()), normals = new Float32Array(normal.getArray());
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  for (const { center, radius, displacement } of deformations) {
    if (![center, radius, displacement].every((v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)) ||
      radius.some((r) => r <= 0)) throw new Error("Surface adjustment requires finite 3D vectors and positive radii");
    const shift = new THREE.Vector3().fromArray(displacement);
    if (shift.length() > Math.min(...radius) * 0.35) throw new Error("Surface adjustment is too large for its falloff");
    for (let i = 0; i < position.getCount(); i++) {
      p.fromArray(positions, i * 3);
      const delta = p.toArray().map((v, k) => v - center[k]);
      const distance = delta.reduce((sum, v, k) => sum + (v / radius[k]) ** 2, 0);
      if (distance > 9) continue;
      const weight = Math.exp(-2 * distance);
      const gradient = new THREE.Vector3(...delta.map((v, k) => -4 * weight * v / radius[k] ** 2));
      n.fromArray(normals, i * 3);
      n.addScaledVector(gradient, -shift.dot(n) / (1 + gradient.dot(shift))).normalize().toArray(normals, i * 3);
      p.addScaledVector(shift, weight).toArray(positions, i * 3);
    }
  }
  position.setArray(positions);
  normal.setArray(normals);
}

async function main() {
  const [input, output, specification] = process.argv.slice(2);
  if (!input || !output || !specification || resolve(input) === resolve(output)) {
    throw new Error("Usage: node scripts/prepare-model-stance.mjs source.glb output.glb stance.json (output must differ)");
  }
  const spec = JSON.parse(await readFile(specification, "utf8"));
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    "draco3d.decoder": await draco.createDecoderModule(), "draco3d.encoder": await draco.createEncoderModule()
  });
  const document = await io.read(input);
  const poseDocument = await io.read(input);
  for (const extension of poseDocument.getRoot().listExtensionsUsed()) {
    if (extension.extensionName === "KHR_draco_mesh_compression") extension.dispose();
  }
  for (const material of poseDocument.getRoot().listMaterials()) {
    material.setBaseColorTexture(null).setNormalTexture(null).setMetallicRoughnessTexture(null)
      .setOcclusionTexture(null).setEmissiveTexture(null);
  }
  const bytes = await io.writeBinary(poseDocument);
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
  const source = gltf.animations.find((clip) => clip.name === spec.sourceRest);
  if (!source) throw new Error(`Missing source rest clip ${spec.sourceRest}`);
  addStance(document, spec.rest, fightStance(gltf.scene, source, spec));
  if (spec.surfaceDeformations?.length) {
    for (const mesh of document.getRoot().listMeshes()) {
      for (const primitive of mesh.listPrimitives()) deformSurface(primitive, spec.surfaceDeformations);
    }
  }
  await document.transform(compress({ method: "edgebreaker", quantizePosition: 16, quantizeNormal: 10, quantizeTexcoord: 14 }));
  await io.write(output, document);
  console.log(`Created ${spec.rest} in ${output}; original rig, textures and moves retained. No API calls.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
