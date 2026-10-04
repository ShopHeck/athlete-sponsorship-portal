// Generate a fictional demo athlete model with Meshy (spends real credits unless MESHY_API_BASE points at a mock).
//   node scripts/generate-demo-model.mjs <spec.json> front   → text-to-image front view (~9 credits)
//   node scripts/generate-demo-model.mjs <spec.json> views   → back/left/right from the front (~27 credits)
//   node scripts/generate-demo-model.mjs <spec.json> model   → multi-image-to-3D + optimize (~35 credits)
// Work files go to $DEMO_WORK_DIR/<slug>/ (default ~/demo-models-work); the optimized GLB is written to
// public/tenants/<slug>/models/<slug>.glb.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createImageToImage,
  createMultiImageTo3D,
  createTextToImage,
  downloadAsset,
  downloadModel,
  getImageToImage,
  getMultiImageTo3D,
  getTextToImage
} from "../netlify/lib/meshy.mjs";
import { optimizeGlb } from "../netlify/lib/optimize-glb.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [specPath, stage] = process.argv.slice(2);
if (!specPath || !["front", "views", "model"].includes(stage)) {
  console.error("usage: generate-demo-model.mjs <spec.json> front|views|model");
  process.exit(2);
}
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const workDir = path.join(process.env.DEMO_WORK_DIR || path.join(homedir(), "demo-models-work"), spec.slug);
mkdirSync(workDir, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const dataUri = (file) => `data:image/png;base64,${readFileSync(path.join(workDir, file)).toString("base64")}`;

async function poll(label, get, id, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const task = await get(id);
    const status = String(task?.status || "").toUpperCase();
    process.stdout.write(`\r${label}: ${status} ${task?.progress ?? 0}%   `);
    if (status === "SUCCEEDED") { process.stdout.write("\n"); return task; }
    if (["FAILED", "CANCELED", "EXPIRED"].includes(status)) {
      throw new Error(`${label} ${status}: ${task?.task_error?.message || "no message"}`);
    }
    await sleep(5000);
  }
  throw new Error(`${label} timed out`);
}

async function saveImage(task, file) {
  const asset = await downloadAsset(task.image_urls[0]);
  writeFileSync(path.join(workDir, file), asset.bytes);
  console.log(`saved ${path.join(workDir, file)}`);
}

if (stage === "front") {
  const id = await createTextToImage({ prompt: spec.front });
  writeFileSync(path.join(workDir, "front.task"), id);
  await saveImage(await poll("front", getTextToImage, id, 10 * 60_000), "front.png");
} else if (stage === "views") {
  const front = dataUri("front.png");
  await Promise.all(Object.entries(spec.views).map(async ([angle, prompt]) => {
    const id = await createImageToImage({ prompt, referenceImageUrls: [front] });
    writeFileSync(path.join(workDir, `${angle}.task`), id);
    await saveImage(await poll(angle, getImageToImage, id, 10 * 60_000), `${angle}.png`);
  }));
} else {
  const imageUrls = ["front", "back", "left", "right"].map((angle) => dataUri(`${angle}.png`));
  const id = await createMultiImageTo3D({ imageUrls });
  writeFileSync(path.join(workDir, "model.task"), id);
  const task = await poll("model", getMultiImageTo3D, id, 20 * 60_000);
  const raw = await downloadModel(task.model_urls.glb);
  writeFileSync(path.join(workDir, "raw.glb"), raw.bytes);
  const optimized = await optimizeGlb(raw.bytes);
  const target = path.join(root, "public/tenants", spec.slug, "models", `${spec.slug}.glb`);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, optimized.bytes);
  console.log(JSON.stringify({ target, bytes: optimized.bytes.length, rawBytes: raw.bytes.length,
    triangles: optimized.triangles, textureSize: optimized.textureSize, bounds: optimized.bounds,
    warnings: optimized.warnings }));
}
