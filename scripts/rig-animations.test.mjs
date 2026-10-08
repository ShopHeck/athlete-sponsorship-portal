import assert from "node:assert/strict";
import test from "node:test";
import { Document } from "@gltf-transform/core";
import { cloneDocument } from "@gltf-transform/functions";
import { transferRigAnimations } from "../netlify/lib/rig-animations.mjs";

function fixture() {
  const doc = new Document(), buffer = doc.createBuffer();
  const hip = doc.createNode("Hips").setTranslation([0, 1, 0]);
  const head = doc.createNode("Head").setTranslation([0, .5, 0]);
  hip.addChild(head);
  const scene = doc.createScene().addChild(hip);
  const mesh = doc.createMesh("Approved likeness");
  for (const name of ["Head and collar", "Body and kit"]) {
    const positions = doc.createAccessor().setType("VEC3")
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer);
    const joints = doc.createAccessor().setType("VEC4")
      .setArray(new Uint16Array([0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0])).setBuffer(buffer);
    const weights = doc.createAccessor().setType("VEC4")
      .setArray(new Float32Array([.75, .25, 0, 0, .75, .25, 0, 0, .75, .25, 0, 0])).setBuffer(buffer);
    mesh.addPrimitive(doc.createPrimitive().setAttribute("POSITION", positions)
      .setAttribute("JOINTS_0", joints).setAttribute("WEIGHTS_0", weights)
      .setMaterial(doc.createMaterial(name)));
  }
  const skin = doc.createSkin("Validated rig").addJoint(hip).addJoint(head);
  scene.addChild(doc.createNode("Model").setMesh(mesh).setSkin(skin));
  return doc;
}

function animate(doc) {
  const buffer = doc.getRoot().listBuffers()[0];
  const input = doc.createAccessor().setType("SCALAR").setArray(new Float32Array([0, 1])).setBuffer(buffer);
  const output = doc.createAccessor().setType("VEC3")
    .setArray(new Float32Array([0, 1, 0, 0, 1.1, 0])).setBuffer(buffer);
  const sampler = doc.createAnimationSampler().setInput(input).setOutput(output);
  const channel = doc.createAnimationChannel().setTargetNode(doc.getRoot().listNodes()[0])
    .setTargetPath("translation").setSampler(sampler);
  doc.createAnimation("Jab").addSampler(sampler).addChannel(channel);
}

test("transfers clips without importing collapsed materials or replacing rig surfaces", () => {
  const rig = fixture(), source = cloneDocument(rig);
  const mesh = rig.getRoot().listMeshes()[0], materials = rig.getRoot().listMaterials();
  const positions = mesh.listPrimitives().map(p => p.getAttribute("POSITION"));
  const joints = mesh.listPrimitives().map(p => p.getAttribute("JOINTS_0"));
  const weights = mesh.listPrimitives().map(p => p.getAttribute("WEIGHTS_0"));
  const skins = rig.getRoot().listSkins();
  const collapsed = source.getRoot().listMaterials()[0];
  for (const primitive of source.getRoot().listMeshes()[0].listPrimitives()) primitive.setMaterial(collapsed);
  animate(source);
  rig.createAnimation("Default");
  assert.equal(transferRigAnimations(rig, source), 1);
  assert.deepEqual(rig.getRoot().listMeshes(), [mesh]);
  assert.deepEqual(rig.getRoot().listMaterials(), materials);
  assert.deepEqual(mesh.listPrimitives().map(p => p.getAttribute("POSITION")), positions);
  assert.deepEqual(mesh.listPrimitives().map(p => p.getAttribute("JOINTS_0")), joints);
  assert.deepEqual(mesh.listPrimitives().map(p => p.getAttribute("WEIGHTS_0")), weights);
  assert.deepEqual(rig.getRoot().listSkins(), skins);
  assert.deepEqual(mesh.listPrimitives().map(p => p.getMaterial()), materials);
  const [clip] = rig.getRoot().listAnimations();
  assert.equal(clip.getName(), "Jab");
  assert.equal(clip.listChannels()[0].getTargetNode(), rig.getRoot().listNodes()[0]);
  assert.notEqual(clip.listSamplers()[0].getOutput(), source.getRoot().listAnimations()[0].listSamplers()[0].getOutput());
});

test("refuses incompatible bind transforms before changing the rig", () => {
  const rig = fixture(), source = cloneDocument(rig);
  source.getRoot().listNodes()[0].setTranslation([0, 2, 0]);
  animate(source);
  assert.throws(() => transferRigAnimations(rig, source), /bind transforms differ/);
  assert.equal(rig.getRoot().listAnimations().length, 0);
  assert.equal(rig.getRoot().listMaterials().length, 2);
});

test("refuses missing clips and ambiguous node names", () => {
  const rig = fixture(), source = cloneDocument(rig);
  assert.throws(() => transferRigAnimations(rig, source), /no clips/);
  animate(source);
  rig.createNode("Hips");
  assert.throws(() => transferRigAnimations(rig, source), /unique target/);
});
