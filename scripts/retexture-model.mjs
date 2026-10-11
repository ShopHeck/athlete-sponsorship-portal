// Re-texture a demo athlete with Meshy 7 PBR maps on its existing UV layout (~10 credits), then put the maps on the
// committed rigged model with scripts/apply-pbr.mjs. Geometry, rig and placements are unchanged.
//   node scripts/retexture-model.mjs <slug> --task <meshy model task id> --views <dir with front.png [left|back|right].png>
//     [--work <dir>]   → <work>/<slug>/{base_color,normal,roughness,metallic}.png
// The task is the multi-image-to-3D task the committed model was built from; the views are the approved reference views
// it was generated from (front first). Run with NODE_USE_ENV_PROXY=1 behind an HTTPS proxy.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createRetexture, downloadTexture, getRetexture } from "../netlify/lib/meshy.mjs";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  task: { type: "string" }, views: { type: "string" }, work: { type: "string" }
} });
const [slug] = positionals;
if (!slug || !values.task || !values.views) {
  console.error("usage: retexture-model.mjs <slug> --task <id> --views <dir> [--work <dir>]");
  process.exit(2);
}
const out = path.join(values.work || process.env.DEMO_WORK_DIR || path.join(homedir(), "demo-models-work"), slug, "retexture");
mkdirSync(out, { recursive: true });
const taskFile = path.join(out, "retexture.task");
let id = existsSync(taskFile) ? readFileSync(taskFile, "utf8").trim() : null;
if (!id) {
  const views = ["front", "left", "back", "right"].map((v) => path.join(values.views, `${v}.png`)).filter(existsSync);
  if (!views[0]?.endsWith("front.png")) throw new Error("the views must include front.png");
  id = await createRetexture({
    inputTaskId: values.task,
    viewImageUrls: views.map((f) => `data:image/png;base64,${readFileSync(f).toString("base64")}`)
  });
  writeFileSync(taskFile, id);
  console.log(`retexture ${id} from ${views.map((f) => path.basename(f)).join(", ")}`);
}
for (;;) {
  const task = await getRetexture(id);
  if (task.status === "SUCCEEDED") {
    for (const [name, url] of Object.entries(task.texture_urls?.[0] || {})) {
      writeFileSync(path.join(out, `${name}.png`), await downloadTexture(url));
    }
    console.log(JSON.stringify({ out, credits: task.consumed_credits, maps: Object.keys(task.texture_urls?.[0] || {}) }));
    break;
  }
  if (["FAILED", "CANCELED", "EXPIRED"].includes(task.status)) throw new Error(`retexture ${task.status}: ${task.task_error?.message || ""}`);
  console.log(`${task.status} ${task.progress ?? 0}%`);
  await new Promise((resolve) => setTimeout(resolve, 15_000));
}
