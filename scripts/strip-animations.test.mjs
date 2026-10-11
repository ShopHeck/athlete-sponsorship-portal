import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Document, NodeIO } from "@gltf-transform/core";
import { stripAnimations } from "./strip-animations.mjs";

const io = new NodeIO();
const parseJson = (glb) => JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString("utf8"));

// A skinned triangle with one animation whose data sits in its own buffer view, as Meshy/optimize-glb lay it out.
async function sample() {
  const doc = new Document(), buffer = doc.createBuffer();
  const accessor = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const joint = doc.createNode("Hips");
  const skin = doc.createSkin().addJoint(joint).setInverseBindMatrices(
    accessor("MAT4", new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])));
  const primitive = doc.createPrimitive()
    .setAttribute("POSITION", accessor("VEC3", new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])))
    .setAttribute("JOINTS_0", accessor("VEC4", new Uint16Array(12)))
    .setAttribute("WEIGHTS_0", accessor("VEC4", new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])));
  const body = doc.createNode("Body").setMesh(doc.createMesh().addPrimitive(primitive)).setSkin(skin);
  doc.createScene().addChild(joint).addChild(body);
  const sampler = doc.createAnimationSampler()
    .setInput(accessor("SCALAR", new Float32Array([0, 1])))
    .setOutput(accessor("VEC4", new Float32Array([0, 0, 0, 1, 0, 0.7071, 0, 0.7071])));
  doc.createAnimation("Victory_Fist_Pump").addSampler(sampler)
    .addChannel(doc.createAnimationChannel().setTargetNode(joint).setTargetPath("rotation").setSampler(sampler));
  return Buffer.from(await io.writeBinary(doc));
}

test("stripAnimations drops only the animations and keeps the mesh and skin intact", async () => {
  const input = await sample();
  const { glb, removed } = stripAnimations(input);
  assert.deepEqual(removed, ["Victory_Fist_Pump"]);
  assert.ok(glb.length < input.length);
  const before = await io.readBinary(new Uint8Array(input)), after = await io.readBinary(new Uint8Array(glb));
  assert.equal(after.getRoot().listAnimations().length, 0);
  for (const name of ["POSITION", "JOINTS_0", "WEIGHTS_0"]) {
    assert.deepEqual([...after.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute(name).getArray()],
      [...before.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute(name).getArray()], name);
  }
  assert.deepEqual([...after.getRoot().listSkins()[0].getInverseBindMatrices().getArray()],
    [...before.getRoot().listSkins()[0].getInverseBindMatrices().getArray()]);
  assert.equal(glb.readUInt32LE(8), glb.length, "header length must match the file");
  assert.equal(stripAnimations(glb).glb, glb, "a model without animations is returned untouched");
});

test("stripAnimations refuses files it cannot carry safely", async () => {
  const input = await sample();
  const json = parseJson(input);
  json.extensionsUsed = ["EXT_meshopt_compression"];
  const text = Buffer.from(JSON.stringify(json).padEnd(Math.ceil(JSON.stringify(json).length / 4) * 4));
  const rest = input.subarray(20 + input.readUInt32LE(12));
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + text.length + rest.length, 8);
  head.writeUInt32LE(text.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  assert.throws(() => stripAnimations(Buffer.concat([head, text, rest])), /unsupported extensions: EXT_meshopt_compression/);
  assert.throws(() => stripAnimations(Buffer.from("not a glb at all")), /not a glTF 2.0 binary/);
});

test("demo models ship without baked clips; their moves are authored in public/motion.js", async () => {
  for (const slug of ["demo-bjj-gi-men", "demo-bjj-gi-women", "demo-boxing-men", "demo-boxing-women", "demo-mma-women", "demo-nogi-men", "demo-nogi-women"]) {
    const config = JSON.parse(await readFile(new URL(`../tenants/${slug}.json`, import.meta.url), "utf8"));
    const glb = await readFile(new URL(`../public/tenants/${slug}/${config.model}`, import.meta.url));
    assert.equal(parseJson(glb).animations, undefined, `${slug} still carries baked clips`);
  }
});
