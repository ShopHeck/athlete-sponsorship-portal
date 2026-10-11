// Removes every baked animation from a GLB without re-encoding anything else, e.g. the Meshy library clips left in
// a demo model whose moves are authored in public/motion.js.
//   node scripts/strip-animations.mjs <in.glb> [out.glb]   (out defaults to in, rewritten in place)
// Only the animations, the accessors they alone use and the buffer views left unused are dropped; every other buffer
// view (Draco geometry, textures, inverse bind matrices) is copied byte for byte, so the mesh, skin and texture are
// identical to the input.
import { readFile, writeFile } from "node:fs/promises";

// Extensions whose data this script knows how to carry: anything else might reference accessors or buffer views.
const KNOWN_EXTENSIONS = new Set([
  "KHR_draco_mesh_compression", "EXT_texture_webp", "KHR_texture_transform", "KHR_mesh_quantization",
  "KHR_materials_emissive_strength", "KHR_materials_specular", "KHR_materials_ior"
]);
const GLB_MAGIC = 0x46546c67, JSON_CHUNK = 0x4e4f534a, BIN_CHUNK = 0x004e4942;
const pad4 = (n) => (n + 3) & ~3;

export function stripAnimations(glb) {
  if (glb.readUInt32LE(0) !== GLB_MAGIC || glb.readUInt32LE(4) !== 2) throw new Error("not a glTF 2.0 binary");
  const jsonLength = glb.readUInt32LE(12);
  if (glb.readUInt32LE(16) !== JSON_CHUNK) throw new Error("GLB must start with a JSON chunk");
  const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString("utf8").trimEnd());
  let bin = Buffer.alloc(0);
  const binAt = 20 + jsonLength;
  if (binAt < glb.length) {
    if (glb.readUInt32LE(binAt + 4) !== BIN_CHUNK) throw new Error("second GLB chunk must be BIN");
    bin = glb.subarray(binAt + 8, binAt + 8 + glb.readUInt32LE(binAt));
  }
  const unknown = (json.extensionsUsed || []).filter((name) => !KNOWN_EXTENSIONS.has(name));
  if (unknown.length) throw new Error(`unsupported extensions: ${unknown.join(", ")}`);
  if ((json.buffers || []).length > 1 || json.buffers?.[0]?.uri) throw new Error("expected a single embedded buffer");
  const removed = (json.animations || []).map((animation) => animation.name);
  if (!removed.length) return { glb, removed };
  delete json.animations;

  // Accessors and buffer views still referenced once the animations are gone.
  const accessors = new Set(), views = new Set();
  for (const mesh of json.meshes || []) for (const primitive of mesh.primitives) {
    for (const index of Object.values(primitive.attributes)) accessors.add(index);
    if (primitive.indices !== undefined) accessors.add(primitive.indices);
    for (const target of primitive.targets || []) for (const index of Object.values(target)) accessors.add(index);
    const draco = primitive.extensions?.KHR_draco_mesh_compression;
    if (draco) views.add(draco.bufferView);
  }
  for (const skin of json.skins || []) if (skin.inverseBindMatrices !== undefined) accessors.add(skin.inverseBindMatrices);
  for (const image of json.images || []) if (image.bufferView !== undefined) views.add(image.bufferView);
  for (const index of accessors) {
    const accessor = json.accessors[index];
    if (accessor.bufferView !== undefined) views.add(accessor.bufferView);
    if (accessor.sparse) views.add(accessor.sparse.indices.bufferView).add(accessor.sparse.values.bufferView);
  }

  const accessorMap = new Map(), viewMap = new Map();
  json.accessors = (json.accessors || []).filter((_, i) => accessors.has(i));
  [...accessors].sort((a, b) => a - b).forEach((i, n) => accessorMap.set(i, n));
  // Keep the surviving views in their original byte order, each starting on a 4-byte boundary.
  const kept = (json.bufferViews || []).map((view, i) => [view, i]).filter(([, i]) => views.has(i));
  const chunks = [];
  let offset = 0;
  for (const [view] of [...kept].sort((a, b) => (a[0].byteOffset || 0) - (b[0].byteOffset || 0))) {
    const start = view.byteOffset || 0;
    chunks.push([offset, bin.subarray(start, start + view.byteLength)]);
    view.byteOffset = offset;
    offset = pad4(offset + view.byteLength);
  }
  json.bufferViews = kept.map(([view]) => view);
  kept.forEach(([, i], n) => viewMap.set(i, n));

  const remapView = (o) => { if (o?.bufferView !== undefined) o.bufferView = viewMap.get(o.bufferView); };
  for (const accessor of json.accessors) {
    remapView(accessor);
    if (accessor.sparse) { remapView(accessor.sparse.indices); remapView(accessor.sparse.values); }
  }
  for (const image of json.images || []) remapView(image);
  for (const mesh of json.meshes || []) for (const primitive of mesh.primitives) {
    for (const key of Object.keys(primitive.attributes)) primitive.attributes[key] = accessorMap.get(primitive.attributes[key]);
    if (primitive.indices !== undefined) primitive.indices = accessorMap.get(primitive.indices);
    for (const target of primitive.targets || []) for (const key of Object.keys(target)) target[key] = accessorMap.get(target[key]);
    remapView(primitive.extensions?.KHR_draco_mesh_compression);
  }
  for (const skin of json.skins || []) {
    if (skin.inverseBindMatrices !== undefined) skin.inverseBindMatrices = accessorMap.get(skin.inverseBindMatrices);
  }

  const binOut = Buffer.alloc(pad4(offset));
  for (const [at, bytes] of chunks) bytes.copy(binOut, at);
  json.buffers = [{ byteLength: offset }];
  const jsonBytes = Buffer.from(JSON.stringify(json), "utf8");
  const jsonOut = Buffer.concat([jsonBytes, Buffer.alloc(pad4(jsonBytes.length) - jsonBytes.length, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonOut.length + 8 + binOut.length, 8);
  const chunkHeader = (length, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(length, 0); h.writeUInt32LE(type, 4); return h; };
  return {
    glb: Buffer.concat([header, chunkHeader(jsonOut.length, JSON_CHUNK), jsonOut, chunkHeader(binOut.length, BIN_CHUNK), binOut]),
    removed
  };
}

async function main() {
  const [input, output = input] = process.argv.slice(2);
  if (!input) throw new Error("usage: strip-animations.mjs <in.glb> [out.glb]");
  const before = await readFile(input);
  const { glb, removed } = stripAnimations(before);
  if (removed.length) await writeFile(output, glb);
  console.log(JSON.stringify({ output, removed, bytes: [before.length, glb.length] }));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
