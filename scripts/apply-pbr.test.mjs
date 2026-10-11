import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import sharp from "sharp";
import { applyPbr, encodeMaps } from "./apply-pbr.mjs";

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const png = (r, g, b) => sharp({ create: { width: 8, height: 8, channels: 3, background: { r, g, b } } }).png().toBuffer();

async function model() {
  const doc = new Document(), buffer = doc.createBuffer();
  doc.createExtension(ALL_EXTENSIONS.find((e) => e.EXTENSION_NAME === "EXT_texture_webp")).setRequired(true);
  const texture = doc.createTexture("Image_0").setMimeType("image/webp")
    .setImage(new Uint8Array(await sharp({ create: { width: 8, height: 8, channels: 3, background: "#808080" } }).webp().toBuffer()));
  const material = doc.createMaterial("Material_0").setBaseColorTexture(texture).setRoughnessFactor(0.8).setMetallicFactor(0);
  const primitive = doc.createPrimitive().setMaterial(material)
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setBuffer(buffer).setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])))
    .setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setBuffer(buffer).setArray(new Float32Array([0, 0, 1, 0, 0, 1])));
  doc.createScene().addChild(doc.createNode("Body").setMesh(doc.createMesh().addPrimitive(primitive)));
  return Buffer.from(await io.writeBinary(doc));
}

test("applyPbr adds normal and roughness maps, swaps the base colour, and keeps the mesh", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "pbr-"));
  try {
    await writeFile(path.join(dir, "base_color.png"), await png(200, 40, 40));
    await writeFile(path.join(dir, "normal.png"), await png(128, 128, 255));
    await writeFile(path.join(dir, "roughness.png"), await png(90, 90, 90));
    const maps = await encodeMaps(dir, { baseSize: 8, mapSize: 8 });
    const input = await model();
    const once = applyPbr(input, maps);
    const doc = await io.readBinary(new Uint8Array(once));
    const material = doc.getRoot().listMaterials()[0];
    assert.ok(material.getNormalTexture(), "normal map added");
    assert.ok(material.getMetallicRoughnessTexture(), "metallic-roughness map added");
    assert.equal(material.getRoughnessFactor(), 1);
    assert.equal(material.getMetallicFactor(), 0, "athletes wear no metal");
    const base = await sharp(Buffer.from(material.getBaseColorTexture().getImage())).raw().toBuffer();
    assert.ok(base[0] > 150 && base[1] < 90, "the base colour is the retexture's");
    const rough = await sharp(Buffer.from(material.getMetallicRoughnessTexture().getImage())).raw().toBuffer();
    assert.ok(Math.abs(rough[1] - 90) < 6 && rough[2] < 6, "roughness in G, no metal in B");
    const before = await io.readBinary(new Uint8Array(input));
    const pos = (d) => [...d.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute("POSITION").getArray()];
    assert.deepEqual(pos(doc), pos(before));
    const twice = await io.readBinary(new Uint8Array(applyPbr(once, maps)));
    assert.equal(twice.getRoot().listTextures().length, 3, "re-applying replaces the maps instead of stacking them");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
