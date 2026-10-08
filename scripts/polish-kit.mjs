// Bake a fabric pass into a Meshy athlete GLB so painted-on clothing reads as garments: a metallic-roughness map
// (matte knit shirt, satin shorts, skin with its own sheen), a normal map with cloth folds and grain, and the shirt
// and shorts lifted a few millimetres off the body so collar, sleeve and hem edges catch the light.
//   node scripts/polish-kit.mjs <slug> [--in file.glb] [--out file.glb] [--dark 0.1]
//     [--shirt yMin,yMax,liftMetres] [--shorts yMin,yMax,liftMetres]
// Garments are found by colour (texels darker than --dark) within the given height bands of the model.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { draco, textureCompress } from "@gltf-transform/functions";
import draco3d from "draco3dgltf";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { in: { type: "string" }, out: { type: "string" }, dark: { type: "string" }, shirt: { type: "string" }, shorts: { type: "string" } }
});
const [slug] = positionals;
if (!slug) { console.error("usage: polish-kit.mjs <slug> [--in file] [--out file]"); process.exit(2); }
const modelPath = path.join(root, "public/tenants", slug, "models", `${slug}-animated.glb`);
const input = values.in || modelPath, output = values.out || modelPath;
const DARK = Number(values.dark || 0.1);
const band = (s, d) => (s ? s.split(",").map(Number) : d);
const SHIRT = band(values.shirt, [0.95, 1.58, 0.006]);
const SHORTS = band(values.shorts, [0.6, 0.98, 0.004]);
const TEX = 2048;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.decoder": await draco3d.createDecoderModule(),
  "draco3d.encoder": await draco3d.createEncoderModule()
});
const doc = await io.readBinary(new Uint8Array(readFileSync(input)));
const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
const material = prim.getMaterial();
const posAcc = prim.getAttribute("POSITION"), uvAcc = prim.getAttribute("TEXCOORD_0");
const pos = Float32Array.from(posAcc.getArray()), uv = uvAcc.getArray(), idx = prim.getIndices().getArray();
const n = pos.length / 3;
const base = await sharp(Buffer.from(material.getBaseColorTexture().getImage())).resize(TEX, TEX, { fit: "fill" }).removeAlpha().raw().toBuffer();
const lumAt = (u, v) => {
  const x = Math.min(TEX - 1, Math.max(0, Math.floor(u * TEX))), y = Math.min(TEX - 1, Math.max(0, Math.floor(v * TEX)));
  const k = (y * TEX + x) * 3;
  return (0.2126 * base[k] + 0.7152 * base[k + 1] + 0.0722 * base[k + 2]) / 255;
};

/* ---------------------------------------------------- vertex classes */
// 1 = shirt, 2 = shorts, 0 = body. Dark texels inside the garment's height band.
const cls = new Uint8Array(n);
for (let i = 0; i < n; i++) {
  const y = pos[i * 3 + 1];
  if (lumAt(uv[i * 2], uv[i * 2 + 1]) >= DARK) continue;
  if (y >= SHIRT[0] && y <= SHIRT[1]) cls[i] = 1;
  else if (y >= SHORTS[0] && y <= SHORTS[1]) cls[i] = 2;
}

// Weld UV-seam duplicates by position so the lift and its smoothing never crack the surface along a seam.
const canon = new Int32Array(n);
{
  const seen = new Map();
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(pos[i * 3] * 1e5)},${Math.round(pos[i * 3 + 1] * 1e5)},${Math.round(pos[i * 3 + 2] * 1e5)}`;
    const c = seen.get(key);
    if (c === undefined) { seen.set(key, i); canon[i] = i; } else canon[i] = c;
  }
}
const neighbours = Array.from({ length: n }, () => null);
const link = (a, b) => { (neighbours[a] ||= new Set()).add(b); (neighbours[b] ||= new Set()).add(a); };
for (let t = 0; t < idx.length; t += 3) {
  const a = canon[idx[t]], b = canon[idx[t + 1]], c = canon[idx[t + 2]];
  link(a, b); link(b, c); link(c, a);
}
// Lift weight per welded vertex: 1 inside a garment, feathered over two rings so the edge is a soft lip, not a saw.
let lift = new Float32Array(n);
for (let i = 0; i < n; i++) if (cls[i]) lift[canon[i]] = Math.max(lift[canon[i]], cls[i] === 1 ? SHIRT[2] : SHORTS[2]);
for (let pass = 0; pass < 2; pass++) {
  const next = Float32Array.from(lift);
  for (let i = 0; i < n; i++) {
    if (canon[i] !== i || !neighbours[i]) continue;
    let sum = lift[i], count = 1;
    for (const j of neighbours[i]) { sum += lift[j]; count++; }
    next[i] = sum / count;
  }
  lift = next;
}
// Smooth welded normals for the lift direction (stored normals split along hard edges and seams).
const smoothN = new Float32Array(n * 3);
for (let t = 0; t < idx.length; t += 3) {
  const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
  const ax = pos[b * 3] - pos[a * 3], ay = pos[b * 3 + 1] - pos[a * 3 + 1], az = pos[b * 3 + 2] - pos[a * 3 + 2];
  const bx = pos[c * 3] - pos[a * 3], by = pos[c * 3 + 1] - pos[a * 3 + 1], bz = pos[c * 3 + 2] - pos[a * 3 + 2];
  const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  for (const v of [canon[a], canon[b], canon[c]]) { smoothN[v * 3] += nx; smoothN[v * 3 + 1] += ny; smoothN[v * 3 + 2] += nz; }
}
let lifted = 0;
for (let i = 0; i < n; i++) {
  const c = canon[i], w = lift[c];
  if (w <= 1e-6) continue;
  const nx = smoothN[c * 3], ny = smoothN[c * 3 + 1], nz = smoothN[c * 3 + 2];
  const len = Math.hypot(nx, ny, nz) || 1;
  pos[i * 3] += (nx / len) * w; pos[i * 3 + 1] += (ny / len) * w; pos[i * 3 + 2] += (nz / len) * w;
  lifted++;
}
posAcc.setArray(pos);

/* ------------------------------------------------- UV-space class mask */
const mask = new Uint8Array(TEX * TEX);
function rasterise(ua, va, ub, vb, uc, vc, ca, cb, cc) {
  const xs = [ua, ub, uc].map((u) => u * TEX), ys = [va, vb, vc].map((v) => v * TEX);
  const minX = Math.max(0, Math.floor(Math.min(...xs))), maxX = Math.min(TEX - 1, Math.ceil(Math.max(...xs)));
  const minY = Math.max(0, Math.floor(Math.min(...ys))), maxY = Math.min(TEX - 1, Math.ceil(Math.max(...ys)));
  const det = (xs[1] - xs[0]) * (ys[2] - ys[0]) - (xs[2] - xs[0]) * (ys[1] - ys[0]);
  if (Math.abs(det) < 1e-9) return;
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const px = x + 0.5, py = y + 0.5;
    let l1 = ((xs[1] - px) * (ys[2] - py) - (xs[2] - px) * (ys[1] - py)) / det;
    let l2 = ((xs[2] - px) * (ys[0] - py) - (xs[0] - px) * (ys[2] - py)) / det;
    let l3 = 1 - l1 - l2;
    if (l1 < -0.02 || l2 < -0.02 || l3 < -0.02) continue;
    const value = ca * l1 + cb * l2 + cc * l3;
    mask[y * TEX + x] = value > 1.5 ? 2 : value > 0.5 ? 1 : 0;
  }
}
for (let t = 0; t < idx.length; t += 3) {
  const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
  if (!cls[a] && !cls[b] && !cls[c]) continue;
  rasterise(uv[a * 2], uv[a * 2 + 1], uv[b * 2], uv[b * 2 + 1], uv[c * 2], uv[c * 2 + 1], cls[a], cls[b], cls[c]);
}

/* --------------------------------------------------------- textures */
// Cheap smooth value noise for folds (low frequency) and weave grain (high frequency).
const hash = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
const smoothstep = (t) => t * t * (3 - 2 * t);
function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = smoothstep(x - xi), fy = smoothstep(y - yi);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
const height = new Float32Array(TEX * TEX);
for (let y = 0; y < TEX; y++) for (let x = 0; x < TEX; x++) {
  const m = mask[y * TEX + x];
  if (!m) continue;
  const folds = noise(x / 36, y / 36) * 0.5 + noise(x / 14, y / 14) * 0.2;
  const grain = m === 1 ? (hash(x, y) * 0.16 + noise(x / 2.1, y / 2.1) * 0.22) : noise(x / 4, y / 4) * 0.08;
  height[y * TEX + x] = (m === 1 ? folds * 0.55 : folds * 0.45) + grain;
}
const normalPx = Buffer.alloc(TEX * TEX * 3, 128);
const mrPx = Buffer.alloc(TEX * TEX * 3);
const baseOut = Buffer.from(base);
const shirtBlack = [26, 25, 27];
for (let y = 0; y < TEX; y++) for (let x = 0; x < TEX; x++) {
  const i = y * TEX + x, k = i * 3, m = mask[i];
  const r = base[k], g = base[k + 1], b = base[k + 2];
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  let rough = 0.52, metal = 0;
  if (m === 1) rough = 0.96;
  else if (m === 2) rough = 0.58;
  else if (lum < DARK) rough = 0.9; // hair, shoes
  else if (lum > 0.72 && Math.max(r, g, b) - Math.min(r, g, b) < 40) rough = 0.86; // hand wraps
  else if (r > g + 20 && g > b + 30) { rough = 0.42; metal = 0.3; } // gold piping
  mrPx[k + 1] = Math.round(rough * 255); mrPx[k + 2] = Math.round(metal * 255);
  if (m) {
    const xl = x > 0 ? x - 1 : x, xr = x < TEX - 1 ? x + 1 : x, yu = y > 0 ? y - 1 : y, yd = y < TEX - 1 ? y + 1 : y;
    const s = m === 1 ? 1.8 : 1.2;
    const dx = (height[y * TEX + xr] - height[y * TEX + xl]) * s, dy = (height[yd * TEX + x] - height[yu * TEX + x]) * s;
    const len = Math.hypot(dx, dy, 1);
    normalPx[k] = Math.round((-dx / len * 0.5 + 0.5) * 255);
    normalPx[k + 1] = Math.round((dy / len * 0.5 + 0.5) * 255);
    normalPx[k + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
  } else normalPx[k + 2] = 255;
  // Lift crushed shirt blacks towards a dyed-cotton black so folds and sponsor art keep some tonal range.
  if (m === 1) for (let c = 0; c < 3; c++) baseOut[k + c] = Math.round(base[k + c] * 0.8 + shirtBlack[c] * 0.6);
}
const png = (buf) => sharp(buf, { raw: { width: TEX, height: TEX, channels: 3 } }).png().toBuffer();
const baseTex = material.getBaseColorTexture();
const baseFull = await sharp(Buffer.from(baseTex.getImage())).metadata();
if (baseFull.width > TEX || baseFull.height > TEX) {
  // Apply the shirt lift at the texture's native size so decal-free detail is kept.
  const full = await sharp(Buffer.from(baseTex.getImage())).removeAlpha().raw().toBuffer();
  const { width: W, height: H } = baseFull;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const mi = Math.floor(y * TEX / H) * TEX + Math.floor(x * TEX / W);
    if (mask[mi] !== 1) continue;
    const k = (y * W + x) * 3;
    for (let c = 0; c < 3; c++) full[k + c] = Math.round(full[k + c] * 0.8 + shirtBlack[c] * 0.6);
  }
  baseTex.setImage(await sharp(full, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer()).setMimeType("image/png");
} else baseTex.setImage(await png(baseOut)).setMimeType("image/png");
material.setMetallicRoughnessTexture(doc.createTexture("kit-roughness").setImage(await png(mrPx)).setMimeType("image/png"))
  .setRoughnessFactor(1).setMetallicFactor(1)
  .setNormalTexture(doc.createTexture("kit-normal").setImage(await png(normalPx)).setMimeType("image/png"))
  .setNormalScale(0.65);

await doc.transform(
  textureCompress({ encoder: sharp, targetFormat: "webp", resize: [4096, 4096], quality: 85, slots: /baseColor/ }),
  textureCompress({ encoder: sharp, targetFormat: "webp", quality: 80, slots: /(normal|metallicRoughness)/ }),
  draco()
);
const bytes = Buffer.from(await io.writeBinary(doc));
writeFileSync(output, bytes);
const counts = { shirt: 0, shorts: 0 };
for (const c of cls) { if (c === 1) counts.shirt++; else if (c === 2) counts.shorts++; }
console.log(JSON.stringify({ output, bytes: bytes.length, vertices: n, lifted, ...counts }));
