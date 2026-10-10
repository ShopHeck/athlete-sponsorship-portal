// Recolours one garment in a model's colour atlas, offline: e.g. Meshy textured champagne-gold trunks as cream.
//   node scripts/recolor-garment.mjs <in.glb> <out.glb> --band 0.62,1.08 --half-width 0.26 \
//     --from 254,230,201 --to 222,186,120 [--distance 70]
// Only texels of triangles inside the body band are touched (heights in metres on a 1.86 m body measured in the
// bind pose, half-width from the body's centre line), and only those within --distance of the --from colour, so skin,
// socks and gloves that share the band keep their colours. Shading is kept by scaling --to with each texel's
// brightness relative to --from. The rig, skin and animations are copied unchanged; the mesh is re-encoded with Draco
// as optimize-glb does, which welds exact duplicate vertices (0.3% on Jada) but keeps every triangle and the bounds.
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { draco } from "@gltf-transform/functions";
import draco3d from "draco3dgltf";
import sharp from "sharp";

const BODY_HEIGHT = 1.86;
const triple = (text) => {
  const v = String(text).split(",").map(Number);
  if (v.length !== 3 || v.some((n) => !Number.isFinite(n))) throw new Error(`expected three numbers, got ${text}`);
  return v;
};
const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export async function recolorGarment(input, output, { band, halfWidth, from, to, distance = 70 }) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    "draco3d.decoder": await draco3d.createDecoderModule(), "draco3d.encoder": await draco3d.createEncoderModule()
  });
  const doc = await io.read(input);
  const texture = doc.getRoot().listMaterials()[0].getBaseColorTexture();
  const { data, info } = await sharp(Buffer.from(texture.getImage())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const mask = new Uint8Array(info.width * info.height);

  const primitives = doc.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives());
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of primitives) {
    const pos = p.getAttribute("POSITION");
    for (let i = 0; i < pos.getCount(); i++) {
      const v = pos.getElement(i, []);
      min = min.map((m, k) => Math.min(m, v[k])); max = max.map((m, k) => Math.max(m, v[k]));
    }
  }
  const scale = BODY_HEIGHT / (max[1] - min[1]);
  const centre = [(min[0] + max[0]) / 2, 0, (min[2] + max[2]) / 2];
  let triangles = 0;
  for (const p of primitives) {
    const pos = p.getAttribute("POSITION"), uv = p.getAttribute("TEXCOORD_0");
    if (!uv) continue;
    const indices = p.getIndices()?.getArray() || Array.from({ length: pos.getCount() }, (_, i) => i);
    for (let t = 0; t < indices.length; t += 3) {
      const ids = [indices[t], indices[t + 1], indices[t + 2]];
      const vs = ids.map((i) => pos.getElement(i, []));
      const y = (vs.reduce((s, v) => s + v[1], 0) / 3 - min[1]) * scale;
      const x = Math.max(...vs.map((v) => Math.hypot(v[0] - centre[0], v[2] - centre[2]))) * scale;
      if (y < band[0] || y > band[1] || x > halfWidth) continue;
      triangles++;
      // Rasterise the triangle in texel space (with a one-texel margin so seams are covered).
      const [a, b, c] = ids.map((i) => { const [u, v] = uv.getElement(i, []); return [u * info.width, v * info.height]; });
      const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])) - 1), x1 = Math.min(info.width - 1, Math.ceil(Math.max(a[0], b[0], c[0])) + 1);
      const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])) - 1), y1 = Math.min(info.height - 1, Math.ceil(Math.max(a[1], b[1], c[1])) + 1);
      const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
      if (!area) continue;
      for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
        const qx = px + 0.5, qy = py + 0.5;
        const w0 = ((b[0] - qx) * (c[1] - qy) - (c[0] - qx) * (b[1] - qy)) / area;
        const w1 = ((c[0] - qx) * (a[1] - qy) - (a[0] - qx) * (c[1] - qy)) / area;
        const w2 = 1 - w0 - w1;
        const edge = 1.5 / Math.sqrt(Math.abs(area));
        if (w0 >= -edge && w1 >= -edge && w2 >= -edge) mask[py * info.width + px] = 1;
      }
    }
  }
  let changed = 0;
  const reference = luma(from);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const o = i * 4, rgb = [data[o], data[o + 1], data[o + 2]];
    if (Math.hypot(rgb[0] - from[0], rgb[1] - from[1], rgb[2] - from[2]) > distance) continue;
    const shade = luma(rgb) / reference;
    for (let k = 0; k < 3; k++) data[o + k] = Math.max(0, Math.min(255, Math.round(to[k] * shade)));
    changed++;
  }
  const encoded = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).webp({ quality: 85 }).toBuffer();
  texture.setImage(encoded).setMimeType("image/webp");
  await doc.transform(draco({ quantizeTexcoord: 12 }));
  await io.write(output, doc);
  return { triangles, texels: mask.reduce((s, m) => s + m, 0), changed };
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    band: { type: "string" }, "half-width": { type: "string" }, from: { type: "string" }, to: { type: "string" }, distance: { type: "string" }
  } });
  const [input, output] = positionals;
  if (!input || !output || !values.band || !values["half-width"] || !values.from || !values.to) {
    throw new Error("usage: recolor-garment.mjs in.glb out.glb --band y0,y1 --half-width m --from r,g,b --to r,g,b [--distance n]");
  }
  const band = values.band.split(",").map(Number);
  const result = await recolorGarment(input, output, {
    band, halfWidth: Number(values["half-width"]), from: triple(values.from), to: triple(values.to),
    distance: values.distance ? Number(values.distance) : undefined
  });
  console.log(JSON.stringify(result));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
