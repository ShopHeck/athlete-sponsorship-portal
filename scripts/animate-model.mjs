// Rig a finished Meshy athlete model and bake library moves into one GLB (spends real credits unless
// MESHY_API_BASE points at a mock): 5 credits for the rig + 3 per action.
//   node scripts/animate-model.mjs <slug> --task <meshy 3D task id> --height <metres> [--actions 0,385,87,...]
//   node scripts/animate-model.mjs <slug> --model-file <textured.glb> --height <metres> --rig-only
//   node scripts/animate-model.mjs <slug> --rig-task <id> --actions 191,193,194,198,210,388
//   node scripts/animate-model.mjs <slug> --from-glb <animated.glb> [--base-rig <rigged.glb>] [--materials-from <original.glb>] [--linear-color] [--pbr-size 2048] [--texcoord-bits 16]
// Writes <DEMO_OUTPUT_DIR or public/tenants/<slug>/models>/<slug>-animated.glb; point the tenant's "model" at it and list the clips
// to offer under "motion".
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createAnimation, createRigging, downloadModel, getAnimation, getRigging } from "../netlify/lib/meshy.mjs";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { copyToDocument } from "@gltf-transform/functions";
import draco3d from "draco3dgltf";
import { optimizeGlb } from "../netlify/lib/optimize-glb.mjs";
import { separateLimbWeights } from "../netlify/lib/skin-cleanup.mjs";
import { sameUvLayout, transferRigAnimations } from "../netlify/lib/rig-animations.mjs";

// Idle, boxing warm-up, boxing practice, chest-pound taunt, victory fist pump, double-biceps flex, dodge & counter.
const DEFAULT_ACTIONS = [0, 385, 87, 88, 403, 388, 93];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    task: { type: "string" }, height: { type: "string" }, actions: { type: "string" },
    "model-file": { type: "string" }, "rig-task": { type: "string" },
    "rig-only": { type: "boolean", default: false },
    "from-glb": { type: "string" }, "linear-color": { type: "boolean", default: false },
    "materials-from": { type: "string" }, "pbr-size": { type: "string" },
    "texcoord-bits": { type: "string" }, "base-rig": { type: "string" }
  }
});
const [slug] = positionals;
const height = Number(values.height);
const inputs = [values["from-glb"], values.task, values["model-file"], values["rig-task"]].filter(Boolean);
if (!slug || inputs.length !== 1 ||
    ((values.task || values["model-file"]) && !(height > 1 && height < 2.5)) ||
    (values["rig-only"] && values["from-glb"])) {
  console.error("usage: animate-model.mjs <slug> (--task <id> --height <metres> | --model-file <textured.glb> --height <metres> | --rig-task <id> | --from-glb <file>) [--rig-only] [--actions 0,385,...] [--materials-from <original.glb>] [--linear-color] [--pbr-size 2048]");
  process.exit(2);
}
const pbrTextureSize = values["pbr-size"] === undefined ? undefined : Number(values["pbr-size"]);
if (pbrTextureSize !== undefined && (!Number.isInteger(pbrTextureSize) || pbrTextureSize < 256 || pbrTextureSize > 4096)) {
  throw new Error("--pbr-size must be an integer between 256 and 4096.");
}
const texcoordBits = values["texcoord-bits"] === undefined ? undefined : Number(values["texcoord-bits"]);
if (texcoordBits !== undefined && (!Number.isInteger(texcoordBits) || texcoordBits < 8 || texcoordBits > 16)) {
  throw new Error("--texcoord-bits must be an integer between 8 and 16.");
}
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  "draco3d.decoder": await draco3d.createDecoderModule(),
  "draco3d.encoder": await draco3d.createEncoderModule()
});
const original = values["materials-from"] ? await io.read(values["materials-from"]) : null;
if (values["base-rig"] && !values["from-glb"]) throw new Error("--base-rig requires --from-glb.");
let baseRig = values["base-rig"] ? await io.read(values["base-rig"]) : null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function uvTriangles(document, material, texCoord) {
  const triangles = [];
  for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
    if (primitive.getMaterial() !== material) continue;
    const uv = primitive.getAttribute(`TEXCOORD_${texCoord}`)?.getArray();
    if (!uv || primitive.getMode() !== 4) throw new Error("Material restoration requires triangle UVs.");
    const indices = primitive.getIndices()?.getArray();
    const count = indices?.length ?? uv.length / 2;
    for (let i = 0; i < count; i += 3) {
      triangles.push([0, 1, 2].map((k) => {
        const vertex = indices ? indices[i + k] : i + k;
        return [uv[vertex * 2], uv[vertex * 2 + 1]];
      }).sort((a, b) => a[0] - b[0] || a[1] - b[1]).flat());
    }
  }
  return triangles;
}

function restoreMaterials(document, source) {
  for (const material of [...document.getRoot().listMaterials()]) {
    const color = material.getBaseColorTexture()?.getImage();
    const matches = source.getRoot().listMaterials().filter((m) => {
      const original = m.getBaseColorTexture()?.getImage();
      return color && original && Buffer.from(color).equals(Buffer.from(original));
    });
    if (matches.length !== 1) throw new Error("Material restoration requires one matching original color atlas.");
    const original = matches[0];
    const texCoords = new Set([original.getBaseColorTextureInfo(), original.getNormalTextureInfo(),
      original.getMetallicRoughnessTextureInfo()].filter(Boolean).map((info) => info.getTexCoord()));
    for (const coord of texCoords) {
      if (!sameUvLayout(uvTriangles(document, material, coord), uvTriangles(source, original, coord))) {
        throw new Error("Material restoration refused: original and animated texture layouts differ.");
      }
    }
    const restored = copyToDocument(document, source, [original]).get(original);
    for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMaterial() === material) primitive.setMaterial(restored);
    }
  }
}

async function poll(label, get, id, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    let task;
    try { task = await get(id); } catch (error) {
      if (error.status !== 429 && error.name !== "TimeoutError") throw error;
      await sleep(10_000);
      continue;
    }
    const status = String(task?.status || "").toUpperCase();
    process.stdout.write(`\r${label}: ${status} ${task?.progress ?? 0}%   `);
    if (status === "SUCCEEDED") { process.stdout.write("\n"); return task; }
    if (["FAILED", "CANCELED", "EXPIRED"].includes(status)) {
      throw new Error(`${label} ${status}: ${task?.task_error?.message || "no message"}`);
    }
    await sleep(process.env.MESHY_API_BASE ? 200 : 5000);
  }
  throw new Error(`${label} timed out`);
}

let raw;
let credits = 0;
if (values["from-glb"]) {
  raw = readFileSync(values["from-glb"]);
} else {
  const actionIds = values.actions ? values.actions.split(",").map(Number) : DEFAULT_ACTIONS;
  if (!actionIds.length || actionIds.some((id) => !Number.isInteger(id) || id < 0)) throw new Error("--actions must be integer action IDs");
  const workDir = path.join(process.env.DEMO_WORK_DIR || path.join(homedir(), "demo-models-work"), slug);
  mkdirSync(workDir, { recursive: true });
  let modelUrl;
  if (values["model-file"]) {
    const bytes = readFileSync(values["model-file"]);
    if (bytes.subarray(0, 4).toString("ascii") !== "glTF") throw new Error("--model-file must be a binary glTF.");
    modelUrl = `data:model/gltf-binary;base64,${bytes.toString("base64")}`;
  }
  const rigId = values["rig-task"] || await createRigging({ inputTaskId: values.task, modelUrl, heightMeters: height });
  writeFileSync(path.join(workDir, "rig.task"), rigId);
  const rig = await poll("rig", getRigging, rigId, 20 * 60_000);
  writeFileSync(path.join(workDir, "rig.result.json"), JSON.stringify(rig, null, 2));
  if (values["rig-only"]) {
    const bytes = (await downloadModel(rig.result.rigged_character_glb_url)).bytes;
    const target = path.join(workDir, "rigged.raw.glb");
    writeFileSync(target, bytes);
    console.log(JSON.stringify({ target, bytes: bytes.length, credits: rig.consumed_credits || 0 }));
    process.exit(0);
  }
  baseRig = await io.readBinary(new Uint8Array((await downloadModel(rig.result.rigged_character_glb_url)).bytes));
  const animId = await createAnimation({ rigTaskId: rigId, actionIds });
  writeFileSync(path.join(workDir, "animation.task"), animId);
  const animation = await poll("animation", getAnimation, animId, 20 * 60_000);
  credits = (rig.consumed_credits || 0) + (animation.consumed_credits || 0);
  raw = (await downloadModel(animation.result.animation_glb_url)).bytes;
  writeFileSync(path.join(workDir, "animated.raw.glb"), raw);
}
const animated = await io.readBinary(new Uint8Array(raw));
const document = baseRig || animated;
if (baseRig) transferRigAnimations(document, animated);
if (original) restoreMaterials(document, original);
const reweighted = baseRig ? 0 : separateLimbWeights(document);
const optimized = await optimizeGlb(Buffer.from(await io.writeBinary(document)), {
  linearColor: values["linear-color"], pbrTextureSize, texcoordBits
});
const target = path.join(process.env.DEMO_OUTPUT_DIR || path.join(root, "public/tenants", slug, "models"), `${slug}-animated.glb`);
mkdirSync(path.dirname(target), { recursive: true });
writeFileSync(target, optimized.bytes);
console.log(JSON.stringify({ target, bytes: optimized.bytes.length, rawBytes: raw.length, credits, reweighted,
  triangles: optimized.triangles, bounds: optimized.bounds, warnings: optimized.warnings }));
