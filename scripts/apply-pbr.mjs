// Puts a Meshy retexture's PBR maps on a rigged demo model without touching its mesh, skin or rig.
//   node scripts/apply-pbr.mjs <model.glb> <texture dir> [out.glb] [--base-size 4096] [--map-size 2048]
// The texture dir holds Meshy's base_color.png, normal.png and roughness.png from a retexture with
// enable_original_uv (scripts/retexture-model.mjs), so they share the model's UV layout. The base colour replaces the
// model's atlas; the normal map and a packed metallic-roughness map (roughness in G, metalness 0: athletes wear no
// metal) are added to its single material. Every other buffer view (Draco mesh, inverse bind matrices) is copied byte
// for byte.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { readGlb, viewBytes, writeGlb } from "./glb-binary.mjs";

export async function encodeMaps(dir, { baseSize = 4096, mapSize = 2048 } = {}) {
  const file = (name) => path.join(dir, name);
  const base = await sharp(file("base_color.png")).resize(baseSize, baseSize).webp({ quality: 88, effort: 5 }).toBuffer();
  // Normal maps carry direction, not colour: keep them near-lossless so lighting stays smooth.
  const normal = await sharp(file("normal.png")).resize(mapSize, mapSize).removeAlpha().webp({ quality: 95, effort: 5 }).toBuffer();
  const rough = await sharp(file("roughness.png")).resize(mapSize, mapSize).greyscale().raw().toBuffer();
  const orm = Buffer.alloc(mapSize * mapSize * 3);
  for (let i = 0; i < rough.length; i++) { orm[i * 3] = 255; orm[i * 3 + 1] = rough[i]; orm[i * 3 + 2] = 0; }
  const metallicRoughness = await sharp(orm, { raw: { width: mapSize, height: mapSize, channels: 3 } }).webp({ quality: 90, effort: 5 }).toBuffer();
  return { base, normal, metallicRoughness };
}

export function applyPbr(glb, { base, normal, metallicRoughness }) {
  const parsed = readGlb(glb);
  const { json } = parsed;
  if ((json.materials || []).length !== 1) throw new Error("expected one material");
  const material = json.materials[0];
  const pbr = material.pbrMetallicRoughness || (material.pbrMetallicRoughness = {});
  const baseTexture = json.textures[pbr.baseColorTexture.index];
  const baseImage = baseTexture.extensions?.EXT_texture_webp?.source ?? baseTexture.source;
  const bytes = json.bufferViews.map((_, i) => Buffer.from(viewBytes(parsed, i)));
  bytes[json.images[baseImage].bufferView] = base;
  json.images[baseImage].mimeType = "image/webp";

  // Re-applying replaces the maps added last time instead of stacking new ones.
  const reuse = (info) => info && json.textures[info.index];
  const addMap = (existing, data, name) => {
    let texture = reuse(existing);
    if (texture) {
      bytes[json.images[texture.extensions.EXT_texture_webp.source].bufferView] = data;
      return existing.index;
    }
    json.bufferViews.push({ buffer: 0, byteLength: data.length });
    bytes.push(data);
    json.images.push({ name, mimeType: "image/webp", bufferView: json.bufferViews.length - 1 });
    texture = { sampler: baseTexture.sampler, extensions: { EXT_texture_webp: { source: json.images.length - 1 } } };
    json.textures.push(texture);
    return json.textures.length - 1;
  };
  material.normalTexture = { index: addMap(material.normalTexture, normal, "Normal") };
  pbr.metallicRoughnessTexture = { index: addMap(pbr.metallicRoughnessTexture, metallicRoughness, "MetallicRoughness") };
  pbr.roughnessFactor = 1;
  pbr.metallicFactor = 0;
  return writeGlb(json, bytes);
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    "base-size": { type: "string" }, "map-size": { type: "string" }
  } });
  const [input, dir, output = input] = positionals;
  if (!input || !dir) throw new Error("usage: apply-pbr.mjs <model.glb> <texture dir> [out.glb] [--base-size 4096] [--map-size 2048]");
  const maps = await encodeMaps(dir, {
    baseSize: Number(values["base-size"] || 4096), mapSize: Number(values["map-size"] || 2048)
  });
  const before = await readFile(input);
  const glb = applyPbr(before, maps);
  await writeFile(output, glb);
  console.log(JSON.stringify({ output, bytes: [before.length, glb.length], maps: Object.fromEntries(Object.entries(maps).map(([k, v]) => [k, v.length])) }));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
