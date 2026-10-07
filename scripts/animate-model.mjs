// Rig a finished Meshy athlete model and bake library moves into one GLB (spends real credits unless
// MESHY_API_BASE points at a mock): 5 credits for the rig + 3 per action.
//   node scripts/animate-model.mjs <slug> --task <meshy 3D task id> --height <metres> [--actions 0,385,87,...]
//   node scripts/animate-model.mjs <slug> --from-glb <animated.glb>   → optimize an already-downloaded result only
// Writes public/tenants/<slug>/models/<slug>-animated.glb; point the tenant's "model" at it and list the clips
// to offer under "motion".
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createAnimation, createRigging, downloadModel, getAnimation, getRigging } from "../netlify/lib/meshy.mjs";
import { NodeIO } from "@gltf-transform/core";
import { optimizeGlb } from "../netlify/lib/optimize-glb.mjs";
import { separateLimbWeights } from "../netlify/lib/skin-cleanup.mjs";

// Idle, boxing warm-up, boxing practice, chest-pound taunt, victory fist pump, double-biceps flex, dodge & counter.
const DEFAULT_ACTIONS = [0, 385, 87, 88, 403, 388, 93];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { task: { type: "string" }, height: { type: "string" }, actions: { type: "string" }, "from-glb": { type: "string" } }
});
const [slug] = positionals;
const height = Number(values.height);
if (!slug || (!values["from-glb"] && (!values.task || !(height > 1 && height < 2.5)))) {
  console.error("usage: animate-model.mjs <slug> --task <id> --height <metres> [--actions 0,385,...] | --from-glb <file>");
  process.exit(2);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const rigId = await createRigging({ inputTaskId: values.task, heightMeters: height });
  writeFileSync(path.join(workDir, "rig.task"), rigId);
  const rig = await poll("rig", getRigging, rigId, 20 * 60_000);
  const animId = await createAnimation({ rigTaskId: rigId, actionIds });
  writeFileSync(path.join(workDir, "animation.task"), animId);
  const animation = await poll("animation", getAnimation, animId, 20 * 60_000);
  credits = (rig.consumed_credits || 0) + (animation.consumed_credits || 0);
  raw = (await downloadModel(animation.result.animation_glb_url)).bytes;
  writeFileSync(path.join(workDir, "animated.raw.glb"), raw);
}
const io = new NodeIO();
const document = await io.readBinary(new Uint8Array(raw));
const reweighted = separateLimbWeights(document);
const optimized = await optimizeGlb(Buffer.from(await io.writeBinary(document)));
const target = path.join(root, "public/tenants", slug, "models", `${slug}-animated.glb`);
mkdirSync(path.dirname(target), { recursive: true });
writeFileSync(target, optimized.bytes);
console.log(JSON.stringify({ target, bytes: optimized.bytes.length, rawBytes: raw.length, credits, reweighted,
  triangles: optimized.triangles, bounds: optimized.bounds, warnings: optimized.warnings }));
