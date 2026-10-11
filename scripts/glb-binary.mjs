// Minimal GLB container access for tools that must not re-encode a model (Draco geometry, textures): read the JSON and
// BIN chunks, then write them back with buffer views laid out afresh.
const GLB_MAGIC = 0x46546c67, JSON_CHUNK = 0x4e4f534a, BIN_CHUNK = 0x004e4942;
export const pad4 = (n) => (n + 3) & ~3;

export function readGlb(glb) {
  if (glb.length < 20 || glb.readUInt32LE(0) !== GLB_MAGIC || glb.readUInt32LE(4) !== 2) throw new Error("not a glTF 2.0 binary");
  const jsonLength = glb.readUInt32LE(12);
  if (glb.readUInt32LE(16) !== JSON_CHUNK) throw new Error("GLB must start with a JSON chunk");
  const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString("utf8").trimEnd());
  let bin = Buffer.alloc(0);
  const binAt = 20 + jsonLength;
  if (binAt < glb.length) {
    if (glb.readUInt32LE(binAt + 4) !== BIN_CHUNK) throw new Error("second GLB chunk must be BIN");
    bin = glb.subarray(binAt + 8, binAt + 8 + glb.readUInt32LE(binAt));
  }
  if ((json.buffers || []).length > 1 || json.buffers?.[0]?.uri) throw new Error("expected a single embedded buffer");
  return { json, bin };
}

// The bytes of buffer view `index`.
export function viewBytes({ json, bin }, index) {
  const view = json.bufferViews[index];
  return bin.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
}

// Writes `json` with its buffer views filled from `bytes` (one Buffer per json.bufferViews entry, same order), each
// starting on a 4-byte boundary.
export function writeGlb(json, bytes) {
  if (bytes.length !== (json.bufferViews || []).length) throw new Error("one byte range per buffer view");
  let offset = 0;
  const placed = bytes.map((chunk, i) => {
    const at = offset;
    json.bufferViews[i].byteOffset = at;
    json.bufferViews[i].byteLength = chunk.length;
    offset = pad4(offset + chunk.length);
    return [at, chunk];
  });
  const binOut = Buffer.alloc(pad4(offset));
  for (const [at, chunk] of placed) chunk.copy(binOut, at);
  json.buffers = [{ byteLength: offset }];
  const text = Buffer.from(JSON.stringify(json), "utf8");
  const jsonOut = Buffer.concat([text, Buffer.alloc(pad4(text.length) - text.length, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonOut.length + 8 + binOut.length, 8);
  const chunk = (length, type) => { const h = Buffer.alloc(8); h.writeUInt32LE(length, 0); h.writeUInt32LE(type, 4); return h; };
  return Buffer.concat([header, chunk(jsonOut.length, JSON_CHUNK), jsonOut, chunk(binOut.length, BIN_CHUNK), binOut]);
}
